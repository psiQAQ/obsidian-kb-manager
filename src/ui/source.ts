// Source control layout adapted from Obsidian Git 2.43.0 (MIT).
import { Menu, Setting, TFile, setIcon, moment } from 'obsidian';
import { assertGitEnabled, pluginNotice } from './device.ts';
import { mount, unmount } from 'svelte';
import { hostname } from 'node:os';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { recheck } from '../kb/catalog.ts';
import { previewVersion } from '../git/versions.ts';
import type { VersionPreview } from '../git/versions.ts';
import { candidates, changeIndex, fileComparison, verifyWorkingFile } from '../git/index-actions.ts';
import type { IndexAction } from '../git/index-actions.ts';
import { Dialog } from './dialog.ts';
import { addTextField } from './text-field.ts';
import { renderCommitMessage } from '../preferences.ts';
import { versions } from './versions.ts';
import { showDiff } from './source-diff.ts';
import { showSourceHistory } from './source-history.ts';
import { conflictFiles } from '../git/index-history.ts';
import { commitAndSync } from './sync.ts';
import type { CommitMode } from '../git/versions.ts';
import FileRow from './source-components/FileRow.svelte';

function group(el:HTMLElement,label:string,outer=false) {
	const section=el.createEl('details',{cls:outer?'tree-item nav-folder kb-git-section':'tree-item nav-folder'});
	section.open=true;
	section.createEl('summary',{text:label});
	return section.createDiv({cls:'tree-item-children'});
}

export async function sourcePanel(plugin:KnowledgeBaseManager,lib:Library,el:HTMLElement,drafts:Map<string,string>,signal?:AbortSignal) {
	const t=plugin.t;
	assertGitEnabled(plugin);
	if (!lib.identity || lib.problem || lib.duplicate) {
		el.createEl('p',{text:lib.problem ?? t('请先解决知识库身份问题','Resolve the library identity first')});
		return;
	}
	const id=lib.identity.id;
	const pref=plugin.preferences(id);
	const readonly=lib.identity.archived || Object.values(plugin.moves).some(m=>m.phase!=='complete' && (m.source===lib.location || m.destination===lib.location));
	const active=()=>!signal?.aborted && el.isConnected;
	const run=(action:()=>Promise<void>)=>()=>{if(active())void action().catch(error=>pluginNotice(plugin,'error',String(error),id,8000));};
	const toolbar=el.createDiv({cls:'nav-buttons-container'});
	function button(icon:string,label:string,action:()=>Promise<void>,disabled=false) {
		const btn=toolbar.createEl('button',{cls:'clickable-icon nav-action-button',attr:{type:'button','aria-label':label,title:label}});
		setIcon(btn,icon);btn.disabled=disabled;
		btn.onclick=run(action);
		return btn;
	}
	button('history',t('历史','History'),()=>showSourceHistory(plugin,id),lib.git!=='local');
	button('refresh-cw',t('刷新','Refresh'),()=>plugin.refresh());
	if (lib.git!=='local'){
		el.createEl('p',{text:t('此库没有独立的本地 Git 仓库','This library has no independent local Git repository')});
		if(lib.git==='missing' && !readonly)button('git-branch-plus',t('初始化 Git','Initialize Git'),()=>versions(plugin,lib,'save'));
		return;
	}
	const dir=await plugin.disk.path(lib.location);
	await recheck(plugin.disk,plugin.config,lib);
	let preview:VersionPreview;
	try {preview=await previewVersion(dir);}
	catch(error) {
		const conflicts=await conflictFiles(dir);
		if(!active())return;
		if(conflicts.length) {
			const section=group(el,t('冲突','Conflicts')+' ('+conflicts.length+')',true);
			for(const file of conflicts)section.createEl('p',{text:file});
		}
		el.createEl('p',{cls:'kb-git-error',text:String(error)});
		return;
	}
	if(!active())return;
	el.createEl('p',{text:preview.branch+' · '+(preview.head.slice(0,10)||t('尚无提交','No commits yet'))});
	if(readonly)el.createEl('p',{text:t('此知识库当前只读','This library is currently read-only')});
	const commitFiles=preview.staged ? candidates(preview,'unstage') : preview.changes;
	let message=drafts.get(id) ?? renderCommitMessage(pref,moment().format(pref.commitDateFormat),hostname(),commitFiles.map(c=>c.file));
	if(!readonly)addTextField(new Setting(el).setName(t('提交说明','Commit message')),message,value=>{message=value;drafts.set(id,value);},
		{example:t('更新知识库笔记','Update knowledge base notes')},true);
	const committed=(submitted:string)=>()=>{if(drafts.get(id)===submitted)drafts.delete(id);};
	const commit=(mode:CommitMode)=>versions(plugin,lib,'save',message,committed(message),mode);
	const smart=pref.autoStageOnEmptyIndex?'smart':'staged';
	button('arrow-up-circle',t('提交并同步','Commit and sync'),()=>commitAndSync(plugin,lib,message,committed(message),smart),readonly);
	button('check',t('预览提交','Preview commit'),()=>commit(smart),readonly || !(pref.autoStageOnEmptyIndex?preview.changes.length:preview.staged));
	const more=button('chevron-down',t('更多提交操作','More commit actions'),()=>{
		const menu=new Menu();
		const item=(title:string,icon:string,enabled:boolean,action:()=>Promise<void>)=>
			menu.addItem(entry=>entry.setTitle(title).setIcon(icon).setDisabled(!enabled).onClick(run(action)));
		item(t('提交已暂存内容','Commit staged'),'git-commit',preview.staged,()=>commit('staged'));
		item(t('暂存全部并提交','Stage all and commit'),'list-plus',!!preview.changes.length,()=>{
			const files=candidates(preview,'stage').map(c=>c.file);
			return files.length ? editIndex('stage',files,()=>commit('staged')) : commit('staged');
		});
		item(t('用暂存内容修订上次提交','Amend staged'),'git-commit',!!preview.head && preview.staged,()=>commit('amend'));
		menu.addSeparator();
		item(t('提交已暂存内容并同步','Commit staged and sync'),'arrow-up-circle',preview.staged,
			()=>commitAndSync(plugin,lib,message,committed(message),'staged'));
		const rect=more.getBoundingClientRect();
		menu.showAtPosition({x:rect.left,y:rect.bottom});
		return Promise.resolve();
	},readonly);
	const refreshLayout=async()=>{
		await plugin.saveLibraryPreferences(lib,{...plugin.prefs.libraries[id],tree:!pref.tree});
		await plugin.refresh();
	};
	button(pref.tree?'list':'folder',t('切换列表或文件树','Switch list or tree'),refreshLayout,readonly);
	function editIndex(action:IndexAction,files:string[],after?:()=>Promise<void>){
		const label=action==='stage'?t('暂存完整文件','Stage whole files'):t('取消暂存','Unstage');
		const modal=new Dialog(plugin.app,label);
		modal.lines([lib.location+' · '+preview.branch,...files]);
		if(after)modal.lines([t('暂存完成后预览提交。取消提交会保留这些暂存项。','After staging, review the commit. Cancelling the commit keeps the staged files.')]);
		if(files.some(file=>preview.changes.some(c=>c.file===file && c.head!==c.stage && c.stage!==c.work))){
			modal.lines([t('包含部分暂存文件。操作将替换该文件当前的索引版本。','Includes partially staged files. This will replace their current index version.')]);
		}
		modal.action(label,async()=>{
			await plugin.exclusiveGit(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await changeIndex(dir,preview,action,files);
			});
			modal.close();await plugin.refresh();await after?.();
		});
		modal.open();
		return Promise.resolve();
	}
	function discard(file:string){
		const relative=lib.location+'/'+file;
		const label=t('丢弃工作区修改','Discard working tree change');
		const modal=new Dialog(plugin.app,label);
		const change=preview.changes.find(c=>c.file===file)!;
		modal.lines([relative,change.stage===0?t('将文件移到回收站','Move this file to trash'):t('恢复暂存区内的文件内容','Restore the file contents from the index')]);
		modal.action(label,async()=>{
			await plugin.exclusiveGit(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				const {before,after}=await fileComparison(dir,preview,file,false);
				await verifyWorkingFile(dir,file);
				const vault=plugin.app.vault;
				const item=vault.getAbstractFileByPath(relative);
				if (after && !(item instanceof TFile))throw new Error(t('Obsidian 未索引此文件','Obsidian has not indexed this file'));
				if (item instanceof TFile) {
					if (!before) await plugin.app.fileManager.trashFile(item);
					else await vault.modifyBinary(item,Uint8Array.from(before).buffer);
				} else if (before) await vault.createBinary(relative,Uint8Array.from(before).buffer);
			});
			modal.close();await plugin.refresh();
		});
		modal.open();
		return Promise.resolve();
	}
	const rows:ReturnType<typeof mount>[]=[];
	signal?.addEventListener('abort',()=>{for(const row of rows)void unmount(row);},{once:true});
	for(const action of ['unstage','stage'] as const){
		const staged=action==='unstage';
		const list=candidates(preview,action);
		const label=staged?t('已暂存的更改','Staged changes'):t('工作区更改','Working tree changes');
		const actionLabel=staged?t('取消暂存','Unstage'):t('暂存','Stage');
		button(staged?'minus-circle':'plus-circle',staged?t('全部取消暂存','Unstage all'):t('全部暂存','Stage all'),()=>editIndex(action,list.map(c=>c.file)),readonly || !list.length);
		const section=group(el,label+' ('+list.length+')',true);
		const folders=new Map([['',section]]);
		for (const change of list){
			const {file}=change, relative=lib.location+'/'+file;
			let container=section,title=file;
			if(pref.tree){
				const parts=file.split('/');
				title=parts.pop()!;
				let prefix='';
				for(const name of parts){
					prefix+=name+'/';
					if(!folders.has(prefix))folders.set(prefix,group(container,name));
					container=folders.get(prefix)!;
				}
			}
			const actions=[];
			const item=plugin.app.vault.getAbstractFileByPath(relative);
			if(item instanceof TFile)actions.push({icon:'go-to-file',label:t('打开文件','Open file'),run:run(async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				if(item.path!==relative)throw new Error(t('路径已变化','File path changed'));
				await plugin.app.workspace.getLeaf('tab').openFile(item);
			})});
			if(!readonly){
				if(!staged)actions.push({icon:'undo',label:t('丢弃工作区修改','Discard working tree change'),run:run(()=>discard(file))});
				actions.push({icon:staged?'minus':'plus',label:actionLabel,run:run(()=>editIndex(action,[file]))});
			}
			const before=staged?change.head:change.stage, after=staged?change.stage:change.work;
			rows.push(mount(FileRow,{target:container,props:{path:file,label:title,actions,
				partial:change.head!==change.stage && change.stage!==change.work?t('部分暂存','Partially staged'):undefined,
				status:!after?'D':!before?'A':'M',description:!after?t('删除','Deleted'):!before?t('新增','Added'):t('修改','Modified'),
				showDiff:run(()=>showDiff(plugin,{id,file,staged}))}}));
		}
	}
}
