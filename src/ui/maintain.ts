import { tr } from '../i18n.ts';
import { TFile } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { digest } from '../fs/vault.ts';
import { discover, recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { applyRepair,examine } from '../kb/maintenance.ts';
import type { VisibleFiles } from '../kb/maintenance.ts';
import { executeMove,planMove } from '../kb/move.ts';
import type { MoveRecord } from '../kb/move.ts';
import { changeIdentity } from './identity.ts';
import { auditLibrary } from '../kb/audit.ts';
import { Dialog } from './dialog.ts';

function visible(plugin:KnowledgeBaseManager):VisibleFiles {
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
	dialog.lines([lib.location+'/kb-manager.json']);
	dialog.text(tr('显示名',"Display name"),name,v=>{name=v;});dialog.text(tr('简介',"Description"),description,v=>{description=v;});
	const confirm=(archive:boolean)=>{
		const next=new Dialog(plugin.app,tr('确认清单修改',"Confirm manifest changes"));
		next.lines([lib.location+'/kb-manager.json',previous.displayName+' → '+name,previous.description+' → '+description,
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

export async function health(plugin:KnowledgeBaseManager,lib:Library){
	const dialog=new Dialog(plugin.app,tr('知识库体检',"Check library"));
	const current=lib.problem || lib.duplicate ? lib : await recheck(plugin.disk,plugin.config,lib);
	const report=current.problem || current.duplicate ? {manual:[],repairs:[]} : await examine(plugin.disk,current,plugin.skeleton);
	const findings=await auditLibrary(plugin.disk,current);
	dialog.lines([lib.location,...report.manual,
		...findings.map(f=>(f.level==='error'?tr('错误','Error'):tr('需复核','Review'))+' · '+f.file+' · '+f.code+' · '+f.message),
		...report.repairs.flatMap(r=>[r.file,...r.fields])]);
	if(!report.manual.length && !findings.length && !report.repairs.length)dialog.lines([tr('体检未发现问题',"No issues found")]);
	for(const item of report.repairs){
		if(lib.identity?.archived || lib.duplicate || lib.problem)continue;
		dialog.action(tr('应用此修复：',"Apply repair: ")+item.file,async()=>{
			await plugin.exclusive(lib.location,()=>applyRepair(plugin.disk,plugin.config,lib,item,visible(plugin)));
			dialog.close();
			const current=(await discover(plugin.disk,plugin.config)).find(l=>l.location===lib.location);
			if(current)await health(plugin,current);
		});
	}
	dialog.open();
}

export async function resumeMove(plugin:KnowledgeBaseManager,record:MoveRecord){
	await plugin.exclusive(record.source,()=>executeMove(plugin.disk,plugin.config,record,visible(plugin),v=>plugin.recordMove(v)),true);
	await plugin.refresh();
}

export function move(plugin:KnowledgeBaseManager,lib:Library){
	const old=lib.location.split('/'), original=old.pop()!;
	let parent=old.join('/'), name=original, additional='';
	const dialog=new Dialog(plugin.app,tr('移动或重命名知识库',"Move or rename knowledge base"));
	const choices=[parent,...plugin.config.parents.filter(p=>p!==parent)];
	dialog.choice(tr('目标父目录',"Destination parent folder"),Object.fromEntries(choices.map(p=>[p,p])),v=>{parent=v;});
	dialog.text(tr('或登记已存在的新父目录',"Or register an existing parent folder"),'',v=>{additional=v.trim();});
	dialog.text(tr('目标目录名',"Destination folder name"),name,v=>{name=v;});
	dialog.action(tr('预览',"Preview"),async()=>{
		const target=additional || parent;
		const proposedConfig=()=>({...plugin.config,parents:[...new Set([...plugin.config.parents,target])]});
		const plan=await planMove(plugin.disk,proposedConfig(),lib,target,name,plugin.skeleton);
		const links=new Set<string>();
		for(const [from,targets] of Object.entries(plugin.app.metadataCache.resolvedLinks)){
			for(const to of Object.keys(targets))if(to.startsWith(lib.location+'/'))links.add(from+' → '+to);
		}
		const confirm=new Dialog(plugin.app,tr('确认目录移动',"Confirm directory move"));
		confirm.lines([...(plugin.config.parents.includes(target)?[]:[tr('登记已有父目录：',"Register existing parent: ")+target]),plan.source+' → '+plan.destination,...plan.changes.flatMap(c=>[c.file,...c.fields]),...plan.warnings,
			tr('以下已解析的链接可能失效。外部剪藏、脚本与动态查询需人工核对。',"These links may break. Review external clippings, scripts and dynamic queries."),...links]);
		confirm.action(tr('移动完整目录',"Move entire directory"),async()=>{
			const fresh=await planMove(plugin.disk,proposedConfig(),lib,target,name,plugin.skeleton);
			if(JSON.stringify({...fresh,token:plan.token})!==JSON.stringify(plan))throw new Error(tr('预览已变化',"Preview has changed"));
			plugin.config=proposedConfig();
			await plugin.recordMove(plan);
			confirm.close();dialog.close();
			try{await resumeMove(plugin,plan);}finally{await plugin.refresh();}
		});confirm.open();
	});dialog.open();
}
