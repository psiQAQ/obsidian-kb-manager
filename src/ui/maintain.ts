import { tr } from '../i18n.ts';
import { Setting, TFile } from 'obsidian';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type KnowledgeBaseManager from '../main.ts';
import { digest, key, statIfPresent } from '../fs/vault.ts';
import { identityFile, inspect, parseIdentity, recheck, writeIdentity } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { readManifestFile, replaceLibraryManifest } from '../kb/manifest-disk.ts';
import { applyRepair, examineBindings } from '../kb/maintenance.ts';
import type { VisibleFiles } from '../kb/maintenance.ts';
import { executeMove,planMove } from '../kb/move.ts';
import type { MoveRecord } from '../kb/move.ts';
import { applyUpgradeChecks, previewUpgradeChecks } from '../kb/upgrade-checks.ts';
import { changeIdentity } from './identity.ts';
import { Dialog } from './dialog.ts';
import { applyLibraryIgnores, previewLibraryIgnores } from '../registry/desktop.ts';

async function logLocation(plugin:KnowledgeBaseManager,location:string) {
	const root=await plugin.disk.path(location);
	if((await readdir(root)).some(name=>name!=='.log' && key(name)==='.log'))throw new Error(tr('已有同名日志位置。','A conflicting log path already exists.'));
	const path=join(root,'.log'),stat=await statIfPresent(path);
	if(stat && !stat.isDirectory())throw new Error(tr('日志位置须为普通目录。','The log location must be a regular directory.'));
	return {path,exists:!!stat};
}

export async function upgradeManifest(plugin:KnowledgeBaseManager,lib:Library) {
	if(lib.identity?.schemaVersion!==1 || lib.identity.archived || lib.duplicate || lib.problem)return;
	const relative=lib.location+'/'+identityFile;
	const {raw,signature}=await readManifestFile(await plugin.disk.path(relative));
	const current=parseIdentity(raw);
	if(signature!==lib.signature || current.schemaVersion!==1)throw new Error(tr('清单已变化，请刷新。','The manifest changed. Refresh the library list.'));
	const updated=writeIdentity(raw,{...current,schemaVersion:2});
	if(parseIdentity(updated).schemaVersion!==2)throw new Error(tr('无法预览清单升级。','Could not preview the manifest upgrade.'));
	const ignores=await previewLibraryIgnores(plugin.disk,lib.location);
	const log=await logLocation(plugin,lib.location);
	const checkUpgrade=await previewUpgradeChecks(plugin.disk,lib);
	const dialog=new Dialog(plugin.app,tr('升级知识库清单','Upgrade library manifest'));
	dialog.facts([[tr('文件','File'),relative],[tr('清单格式','Manifest schema'),'1 → 2'],[tr('知识库 ID','Library ID'),current.id]]);
	dialog.contentEl.createEl('p',{text:log.exists?tr('使用现有的 .log/ 目录保存检验日志。','Use the existing .log/ directory for check logs.'):tr('创建 .log/ 目录以保存检验日志。','Create .log/ for check logs.')});
	if(ignores.before!==ignores.after){
		dialog.contentEl.createEl('p',{text:tr('在本库 .gitignore 末尾追加规则','Append rules to this library’s .gitignore')});
		dialog.contentEl.createEl('pre').createEl('code',{text:ignores.after.slice(ignores.before?.length ?? 0).trim()});
	}
	if(checkUpgrade.manual.length){
		dialog.contentEl.createEl('p',{text:tr('专项文件需人工核对。本次升级会更新清单格式和日志位置。','Review the check files manually. This upgrade updates the manifest format and log location.')});
		dialog.lines(checkUpgrade.manual);
	} else if(!checkUpgrade.files.length){
		dialog.contentEl.createEl('p',{text:tr('当前版本提供通用体检和日志。','General checks and logs are available for this template version.')});
	} else {
		for(const file of checkUpgrade.files){
			const item=dialog.contentEl.createEl('details');
			item.createEl('summary',{text:(file.existing?tr('已匹配 ','Matched '):tr('创建 ','Create '))+lib.location+'/'+file.path});
			item.createEl('p',{text:'SHA-256 '+file.fingerprint});
			item.createEl('pre').createEl('code',{text:file.content});
		}
	}
	dialog.action(tr('应用清单升级','Apply manifest upgrade'),async()=>{
		await plugin.exclusive(lib.location,async()=>{
			const library=await recheck(plugin.disk,plugin.config,lib);
			const target=await logLocation(plugin,lib.location);
			if(target.path!==log.path || target.exists!==log.exists)throw new Error(tr('日志位置已变化，请重新预览。','The log location changed. Preview again.'));
			await applyUpgradeChecks(plugin.disk,library,checkUpgrade);
			await applyLibraryIgnores(plugin.disk,ignores);
			if(!target.exists)await mkdir(target.path);
			await replaceLibraryManifest(plugin.disk,lib.location,signature,updated);
		});
		dialog.close();await plugin.refresh();
	}).setCta();
	dialog.open();
}

export function visible(plugin:KnowledgeBaseManager):VisibleFiles {
	const vault=plugin.app.vault;
	return {
		create:async(relative,content)=>{await plugin.disk.path(relative);await vault.create(relative,content);},
		replace:async(relative,before,after)=>{
			await plugin.disk.path(relative);
			const file=vault.getAbstractFileByPath(relative);
			if(!(file instanceof TFile))throw new Error(tr('等待 Obsidian 刷新路径后，请在管理器中继续',"Wait for Obsidian to refresh the path, then continue in the manager"));
			await vault.process(file,text=>{
				if(digest(text)!==before)throw new Error(tr('文件已变化，请重新预览：',"File changed. Preview again: ")+relative);
				return after;
			});
		}
	};
}

export function edit(plugin:KnowledgeBaseManager,lib:Library){
	if(!lib.identity)return;
	const previous=lib.identity;
	let name=previous.displayName,description=previous.description;
	const dialog=new Dialog(plugin.app,tr('编辑知识库',"Edit knowledge base"));
	dialog.lines([lib.location+'/kb.toml']);
	dialog.text(tr('显示名',"Display name"),name,v=>{name=v;});dialog.multiline(tr('简介',"Description"),description,v=>{description=v;});
	const confirm=(archive:boolean)=>{
		const next=new Dialog(plugin.app,tr('确认清单修改',"Confirm manifest changes"));
		next.lines([lib.location+'/kb.toml',previous.displayName+' → '+name,previous.description+' → '+description,
			tr('归档：',"Archived: ")+String(previous.archived)+' → '+String(archive)]);
		next.action(tr('应用',"Apply"),async()=>{
			if(!name.trim())throw new Error(tr('请输入显示名',"Enter a display name"));
			await plugin.exclusive(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await changeIdentity(plugin,lib,value=>{value.displayName=name;value.description=description;value.archived=archive;});
			});
			next.close();dialog.close();await plugin.refresh();
		});next.open();
	};
	dialog.action(tr('预览元信息',"Preview metadata"),()=>{confirm(previous.archived);return Promise.resolve();});
	dialog.action(previous.archived?tr('恢复活动状态',"Restore to active"):tr('归档',"Archive"),()=>{confirm(!previous.archived);return Promise.resolve();});
	dialog.open();
}

export async function maintainBindings(plugin:KnowledgeBaseManager,lib:Library) {
	const library=await recheck(plugin.disk,plugin.config,lib);
	const {manual,repairs}=await examineBindings(plugin.disk,library,plugin.templateAssets(library));
	const dialog=new Dialog(plugin.app,tr('维护受管文件','Maintain managed files'));
	dialog.facts([[tr('知识库','Library'),library.location]]);
	if(manual.length)dialog.lines(manual);
	if(!manual.length && !repairs.length)dialog.contentEl.createEl('p',{text:tr('没有需要维护的受管文件。','No managed files require maintenance.')});
	for(const item of repairs){
		new Setting(dialog.contentEl).setName(item.file).setDesc(item.fields.join('\n')).addButton(button=>{
			button.setButtonText(tr('预览修复','Preview repair')).onClick(()=>{
				const preview=new Dialog(plugin.app,tr('预览受管文件修复','Preview managed file repair'));
				preview.lines([library.location+'/'+item.file,...item.fields]);
				preview.contentEl.createEl('pre').createEl('code',{text:item.after});
				if(!library.identity?.archived)preview.action(tr('应用此修复','Apply this repair'),async()=>{
					await plugin.exclusive(library.location,()=>applyRepair(plugin.disk,plugin.config,library,item,visible(plugin),plugin.templateAssets(library)));
					preview.close();dialog.close();
					await plugin.refresh();
					const fresh=await inspect(plugin.disk,library.location);
					if(fresh)await maintainBindings(plugin,fresh);
				}).setCta();
				preview.open();
			});
		});
	}
	dialog.open();
}

export async function resumeMove(plugin:KnowledgeBaseManager,record:MoveRecord){
	await plugin.exclusive(record.source,()=>executeMove(plugin.disk,plugin.config,record,visible(plugin),v=>plugin.recordMove(v),plugin.kepanoSkeleton),true);
	await plugin.refresh();
}

export function move(plugin:KnowledgeBaseManager,lib:Library){
	const old=lib.location.split('/'), original=old.pop()!;
	const originalParent=old.join('/');
	let parent=plugin.config.parents.includes(originalParent)?originalParent:plugin.config.parents[0]??'', name=original, additional='';
	const dialog=new Dialog(plugin.app,tr('移动或重命名知识库',"Move or rename knowledge base"));
	const choices=[parent,...plugin.config.parents.filter(p=>p!==parent)].filter(Boolean);
	dialog.choice(tr('目标父目录',"Destination parent folder"),Object.fromEntries(choices.map(p=>[p,p])),v=>{parent=v;});
	dialog.text(tr('或登记已存在的新父目录',"Or register an existing parent folder"),'',v=>{additional=v.trim();},{example:'knowledge-base'});
	dialog.text(tr('目标目录名',"Destination folder name"),name,v=>{name=v;});
	dialog.action(tr('预览',"Preview"),async()=>{
		const target=additional || parent;
		const proposedConfig=()=>({...plugin.config,parents:[...new Set([...plugin.config.parents,target])]});
		const skeleton=plugin.templateAssets(lib);
		const plan=await planMove(plugin.disk,proposedConfig(),lib,target,name,skeleton);
		const links=new Set<string>();
		for(const [from,targets] of Object.entries(plugin.app.metadataCache.resolvedLinks)){
			for(const to of Object.keys(targets))if(to.startsWith(lib.location+'/'))links.add(from+' → '+to);
		}
		const confirm=new Dialog(plugin.app,tr('确认目录移动',"Confirm directory move"));
		confirm.lines([...(plugin.config.parents.includes(target)?[]:[tr('登记已有父目录：',"Register existing parent: ")+target]),plan.source+' → '+plan.destination,...plan.changes.flatMap(c=>[c.file,...c.fields]),...plan.warnings,
			tr('以下已解析的链接可能失效。外部剪藏、脚本与动态查询需人工核对。',"These links may break. Review external clippings, scripts and dynamic queries."),...links]);
		confirm.action(tr('移动完整目录',"Move entire directory"),async()=>{
			const fresh=await planMove(plugin.disk,proposedConfig(),lib,target,name,skeleton);
			if(JSON.stringify({...fresh,token:plan.token})!==JSON.stringify(plan))throw new Error(tr('预览已变化',"Preview has changed"));
			plugin.config=proposedConfig();
			await plugin.recordMove(plan);
			confirm.close();dialog.close();
			try{await resumeMove(plugin,plan);}finally{await plugin.refresh();}
		});confirm.open();
	});dialog.open();
}
