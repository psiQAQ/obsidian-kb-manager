import { assertGitEnabled,pluginNotice } from './device.ts';
import { MarkdownView } from 'obsidian';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { statIfPresent } from '../fs/vault.ts';
import { previewVersion } from '../git/versions.ts';
import { candidates, changeIndex } from '../git/index-actions.ts';
import { remoteState } from '../git/network.ts';
import { Dialog } from './dialog.ts';
import { changeActions, changeComparison } from './change-preview.ts';
import { showDiff } from './source-diff.ts';
import { tr } from '../i18n.ts';

const commands = [
	['stage-current-file','暂存当前文件','Stage current file'],
	['unstage-current-file','取消暂存当前文件','Unstage current file'],
	['open-diff-view','查看当前文件差异','View current file changes'],
	['edit-gitignore','编辑本库忽略规则','Edit library ignore rules'],
	['add-to-gitignore','在本库忽略当前文件','Ignore current file in library'],
	['view-file-on-github','在 GitHub 查看当前文件','View current file on GitHub'],
	['view-history-on-github','在 GitHub 查看当前文件历史','View current file history on GitHub'],
] as const;

export function registerFileCommands(plugin:KnowledgeBaseManager, reload:boolean){
	for(const [id,zh,en] of commands){
		if(reload)plugin.removeCommand(id);
		plugin.addCommand({id,name:tr(zh,en),callback:async()=>{
			try{await fileAction(plugin,id,tr(zh,en));}catch(error){pluginNotice(plugin,'error',String(error),undefined,8000);}
		}});
	}
}

async function fileAction(plugin:KnowledgeBaseManager, action:typeof commands[number][0], title:string) {
	assertGitEnabled(plugin);
	const note=plugin.app.workspace.getActiveFile();
	const line=(plugin.app.workspace.getActiveViewOfType(MarkdownView)?.editor.getCursor().line ?? 0)+1;
	const lib=(await discover(plugin.disk,plugin.config)).find(l=>note?.path.startsWith(l.location+'/'));
	if(!lib?.identity || !note)throw new Error(tr('请打开知识库内的笔记','Open a note in a managed library'));
	await recheck(plugin.disk,plugin.config,lib);
	const id=lib.identity.id, dir=await plugin.disk.path(lib.location), file=note.path.slice(lib.location.length+1);
	const preview=await previewVersion(dir);
	const dialog=new Dialog(plugin.app,title);
	dialog.lines([lib.location+' · '+preview.branch,file]);
	if(action.endsWith('on-github')){
		const target=(await remoteState(dir)).target;
		const url=target && new URL(target.url);
		if(!url || url.host!=='github.com' || !/^\/[\w.-]+\/[\w.-]+\/?$/u.test(url.pathname))throw new Error(tr('本库未绑定 GitHub 远端','This library has no GitHub upstream'));
		const route=action==='view-file-on-github'?'blob':'commits';
		const root=url.pathname.replace(/\/$/u,'').replace(/\.git$/u,'');
		const address='https://github.com'+root+'/'+route+'/'+encodeURIComponent(target.remoteBranch)+'/'+file.split('/').map(encodeURIComponent).join('/')+(route==='blob'?'?plain=1#L'+line:'');
		window.open(address,'_blank','noopener');
		return;
	}
	if(action==='open-diff-view'){
		for(const staged of [true,false])if(candidates(preview,staged?'unstage':'stage').some(c=>c.file===file)){
			dialog.action(staged?tr('已暂存','Staged'):tr('工作区','Working tree'),async()=>{
				dialog.close();await showDiff(plugin,{id,file,staged});
			});
		}
		if(!preview.changes.some(c=>c.file===file))dialog.lines([tr('无变更','No changes')]);
		dialog.open();return;
	}
	if(lib.identity.archived)throw new Error(tr('已归档的知识库只读','Archived libraries are read-only'));
	if(action==='stage-current-file' || action==='unstage-current-file'){
		const op=action==='stage-current-file'?'stage':'unstage';
		const entry=candidates(preview,op).find(c=>c.file===file);
		if(!entry)throw new Error(tr('当前文件没有对应改动','This file has no matching changes'));
		if(entry.head!==entry.stage && entry.stage!==entry.work)dialog.lines([tr('将替换此文件的部分暂存内容','This replaces the partially staged version of this file')]);
		changeActions(dialog.contentEl,[{label:title,primary:true,run:async()=>{
			await plugin.exclusiveGit(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);await changeIndex(dir,preview,op,[file]);
			});
			dialog.close();await plugin.refresh();
		}}]);
		dialog.open();return;
	}
	const filename=join(dir,'.gitignore');
	const read=async()=>{
		const st=await statIfPresent(filename);
		if(!st)return undefined;
		if(!st.isFile() || st.nlink!==1)throw new Error(tr('忽略规则必须为独立文件','Ignore rules must be a regular, unlinked file'));
		return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await fs.readFile(filename));
	};
	const before=await read(), original=before??'', newline=original.includes('\r\n')?'\r\n':'\n';
	const rule='/'+file.replace(/[\\*?[\] ]/gu,'\\$&');
	let after=action==='add-to-gitignore' ? original+(original && !original.endsWith('\n')?newline:'')+rule+newline : original;
	if(action==='edit-gitignore')dialog.multiline('.gitignore',original,value=>{after=value.replace(/\r?\n/gu,newline);});
	dialog.action(tr('预览规则','Preview rules'),async origin=>{
		if(after===original)return;
		const approved=after;
		const confirmation=new Dialog(plugin.app,tr('确认忽略规则','Confirm ignore rules'),dialog.owner).returnFocusTo(origin);
		changeComparison(confirmation.contentEl,[{label:lib.location+'/.gitignore',
			before:before??tr('文件缺失','File missing'),after:approved,code:true}]);
		changeActions(confirmation.contentEl,[{label:tr('保存本库忽略规则','Save library ignore rules'),primary:true,run:async()=>{
			await plugin.exclusiveGit(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				if(await read()!==before)throw new Error(tr('忽略规则已变化，请重新预览','Ignore rules changed. Preview again.'));
				if(before===undefined)await fs.writeFile(filename,approved,{flag:'wx'});
				else await plugin.app.vault.adapter.process(lib.location+'/.gitignore',text=>{
					if(text!==before)throw new Error(tr('忽略规则已变化','Ignore rules changed'));
					return approved;
				});
			});
			confirmation.close();dialog.close();await plugin.refresh();
		}}]);confirmation.open();await Promise.resolve();
	}).setCta();
	dialog.open();
}
