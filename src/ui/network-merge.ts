import {Notice,Setting,TFile} from 'obsidian';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type KnowledgeBaseManager from '../main.ts';
import {statIfPresent} from '../fs/vault.ts';
import {recheck} from '../kb/catalog.ts';
import type {Library} from '../kb/catalog.ts';
import {clearUndo,finishMerge,inspectMerge,markResolved,undoInfo} from '../git/network-merge.ts';
import {Dialog} from './dialog.ts';

export async function mergePanel(plugin:KnowledgeBaseManager,lib:Library,el:HTMLElement,dir:string){
	const t=plugin.t,metadata=path.join(dir,'.git');
	if(await statIfPresent(path.join(metadata,'rebase-merge'))||await statIfPresent(path.join(metadata,'rebase-apply'))){
		el.createEl('p',{text:t('变基正在进行。请在该知识库中完成或中止变基，然后刷新。','Rebase in progress. Complete or abort it in this library, then refresh.')});return true;
	}
	const prefs=plugin.preferences(lib.identity!.id);
	if(!await statIfPresent(path.join(metadata,'MERGE_HEAD'))){
		const index=path.join(metadata,'index');
		if(!((await statIfPresent(index))?.isFile()) || !(await fs.readFile(index)).includes('REUC'))return false;
		if(prefs.backend!=='native'){
			el.createEl('p',{text:t('索引保留了解决冲突前的版本。选择原生后端可查看。','The index retains previous conflict versions. Select native Git to review them.')});
			return true;
		}
		const preview=await undoInfo(dir);
		if(!preview.entries.length)return false;
		new Setting(el).setName(t('Git 已保留冲突撤销记录','Git retained resolve-undo entries'))
			.setDesc(t('保留时可用原生 Git 重建冲突。清除记录后可继续在面板暂存。','Native Git can use these records to recreate conflicts. Clear them to resume staging from this panel.'))
			.addButton(b=>b.setButtonText(t('查看记录','Review entries')).onClick(()=>{
				const modal=new Dialog(plugin.app,t('清除冲突撤销记录','Clear resolve-undo entries'));
				modal.lines([lib.location,...preview.entries]);
				modal.action(t('清除列出的撤销记录','Clear listed records'),async()=>{
					await plugin.exclusiveGit(lib.location,async()=>{await recheck(plugin.disk,plugin.config,lib);await clearUndo(dir,preview);});
					modal.close();await plugin.refresh();
				});modal.open();
			}));
		return true;
	}
	if(prefs.backend!=='native'){
		el.createEl('p',{text:t('处理现有合并请在本库设置选择原生 Git，或用原有 Git 工具完成。','To finish this merge, select native Git for this library or complete it with your existing Git tool.')});
		return true;
	}
	const inspect=async()=>{await recheck(plugin.disk,plugin.config,lib);return inspectMerge(dir);};
	const plan=await inspect();
	el.createEl('p',{text:plan.branch+' · '+plan.head.slice(0,10)+' + '+plan.other.slice(0,10)});
	const run=(f:()=>Promise<void>)=>()=>{void f().catch((e:unknown)=>new Notice(String(e),8000));};
	for(const conflict of plan.conflicts){
		const row=new Setting(el).setName(conflict.file).setDesc(conflict.stages.map(s=>s.stage+': '+s.oid.slice(0,10)).join(' · '));
		const source=lib.location+'/'+conflict.file;
		const item=plugin.app.vault.getAbstractFileByPath(source);
		if(item instanceof TFile)row.addExtraButton(b=>b.setIcon('file-pen-line').setTooltip(t('打开冲突文件','Open conflicted file')).onClick(run(async()=>{
			await recheck(plugin.disk,plugin.config,lib);
			if(item.path===source)await plugin.app.workspace.getLeaf('tab').openFile(item);
		})));
		row.addButton(b=>b.setButtonText(t('预览解决结果','Preview resolution')).onClick(run(async()=>{
			const fresh=await inspect(),file=fresh.conflicts.find(c=>c.file===conflict.file);
			if(!file)throw new Error(t('冲突状态已变化，请刷新','Conflict changed. Refresh the panel.'));
			const modal=new Dialog(plugin.app,t('标记文件已解决','Mark file resolved'));
			modal.lines([source,file.work?t('暂存编辑后的文件','Stage edited file'):t('暂存删除','Stage deletion'),...file.stages.map(s=>s.stage+' · '+s.oid)]);
			if(file.work){
				const location=path.join(dir,file.file),size=(await fs.stat(location)).size;
				if(size<=65536){
					const bytes=await fs.readFile(location);
					if(!bytes.includes(0))modal.contentEl.createEl('pre',{text:bytes.toString('utf8')});
					else modal.lines([size+' B · '+file.work]);
				}else modal.lines([size+' B · '+file.work]);
			}
			modal.action(t('仅标记此文件','Mark only this file'),async()=>{
				await plugin.exclusiveGit(lib.location,async()=>{await recheck(plugin.disk,plugin.config,lib);await markResolved(dir,fresh,file.file);});
				modal.close();await plugin.refresh();
			});modal.open();
		})));
	}
	if(!plan.conflicts.length)new Setting(el).addButton(b=>b.setButtonText(t('预览合并提交','Preview merge commit')).onClick(run(async()=>{
		const fresh=await inspect();
		const modal=new Dialog(plugin.app,t('完成本库合并','Finish library merge'));
		modal.lines([lib.location,fresh.head+' + '+fresh.other,...fresh.stagedPaths]);
		let message='Merge '+fresh.other.slice(0,10)+' into '+fresh.branch;
		let name=prefs.author,email=prefs.email;
		modal.text(t('提交说明','Commit message'),message,v=>{message=v;});
		modal.text(t('作者','Author'),name,v=>{name=v;});
		modal.text(t('邮箱','Email'),email,v=>{email=v;});
		modal.action(t('提交当前索引','Commit current index'),async()=>{
			await plugin.exclusiveGit(lib.location,async()=>{await recheck(plugin.disk,plugin.config,lib);await finishMerge(dir,fresh,message,name,email);});
			modal.close();await plugin.refresh();
		});modal.open();
	})));
	return true;
}
