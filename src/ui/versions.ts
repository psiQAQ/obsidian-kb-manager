import { moment } from 'obsidian';
import { hostname } from 'node:os';
import { renderCommitMessage } from '../preferences.ts';
import { tr } from '../i18n.ts';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { previewVersion, saveVersion } from '../git/versions.ts';
import type { CommitMode } from '../git/versions.ts';
import { candidates } from '../git/index-actions.ts';
import { initializeRepository,readCommit } from '../git/repository.ts';
import { showSourceHistory } from './source-history.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled } from './device.ts';
import { editRepositoryIdentity, identitySourceText } from './repository-identity.ts';

export async function versions(plugin: KnowledgeBaseManager, lib: Library, mode:'save'|'history', draft?: string, onCommitted?:()=>void|Promise<void>, commitMode:CommitMode='smart') {
	assertGitEnabled(plugin);
	await recheck(plugin.disk,plugin.config,lib);
	const dir=await plugin.disk.path(lib.location);
	const prefs=plugin.preferences(lib.identity?.id);
	if(commitMode==='smart' && !prefs.autoStageOnEmptyIndex)commitMode='staged';
	const dialog=new Dialog(plugin.app,mode==='save'?(lib.git==='missing'?tr('初始化本库 Git','Initialize library Git'):tr('预览提交','Preview commit')):tr('本库历史','Library history'));
	dialog.facts([[tr('知识库','Knowledge base'),lib.identity?.displayName ?? lib.location],[tr('路径','Path'),lib.location]]);
	if(lib.git==='missing'){
		dialog.lines([tr('此库没有 Git 历史。初始化将创建 .git/ 和 main 分支。',"This library has no Git history. Initialization creates .git/ and a main branch.")]);
		if(!lib.identity?.archived)dialog.action(tr('初始化本地 Git',"Initialize local Git"),async()=>{
			await plugin.exclusiveGit(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await initializeRepository(dir);
			});
			dialog.close();await plugin.refresh();
		});
	} else if(mode==='history'){
		if(!lib.identity)throw new Error(tr('库身份已失效','Library identity is no longer valid'));
		return showSourceHistory(plugin,lib.identity.id);
	} else {
		if(lib.identity?.archived)throw new Error(tr('请先恢复此库',"Restore this library first"));
		const preview=await previewVersion(dir);
		if(commitMode!=='smart' && !preview.staged)throw new Error(tr('请先暂存要提交的内容','Stage changes first'));
		if(commitMode==='amend' && !preview.head)throw new Error(tr('没有可修订的提交','No commit to amend'));
		const original=commitMode==='amend'?(await readCommit(dir,preview.head)).commit:undefined;
		dialog.facts([[tr('分支','Branch'),preview.branch],[tr('当前提交','Current commit'),preview.head||tr('无提交','No commits')]]);
		if(original)dialog.contentEl.createEl('p',{text:tr('修订将替换上一次提交，并保留原作者。','Amending replaces the previous commit and keeps its author.')});
		const previous=lib.identity && plugin.saves[lib.identity.id];
		if(previous && !previous.committed)dialog.lines([
			previous.candidate===preview.head?tr('上次提交已写入：',"Previous commit exists: ")+preview.head:tr('上次操作尚未确认完成，当前 HEAD：',"Previous operation is unconfirmed. Current HEAD: ")+(preview.head||tr('空',"empty")),
			tr('上次说明：',"Previous message: ")+previous.message,tr('已记录暂存：',"Recorded staged files: ")+(previous.staged.join('、')||tr('无',"none")),previous.problem??'',
		]);
		if(preview.changes.length){
			const staged=candidates(preview,'unstage'),working=candidates(preview,'stage');
			const included=preview.staged?staged:working;
			const files=included.map(c=>c.file);
			let message=draft ?? renderCommitMessage(prefs,moment().format(prefs.commitDateFormat),hostname(),files);
			dialog.multiline(tr('提交说明','Commit message'),message,v=>{message=v;},{example:tr('更新知识库笔记','Update knowledge base notes')});
			if(prefs.listChangedFilesInMessageBody)dialog.contentEl.createEl('p',{text:tr('提交正文将附上本次提交的文件名。','Filenames included in this commit are appended to the commit body.')});
			const signature=(name:string,email:string)=>(name||'—')+' <'+(email||'—')+'>';
			const currentSignature=signature(preview.identity.name,preview.identity.email);
			dialog.contentEl.createEl('h3',{text:tr('提交身份','Commit identity')});
			dialog.facts([[tr('作者','Author'),original?signature(original.author.name,original.author.email):currentSignature],
				[tr('提交者','Committer'),currentSignature],...(['name','email'] as const).map(key=>
					['user.'+key,identitySourceText(preview.identitySources[key])] as const)]);
			if(!preview.identity.name || !preview.identity.email)dialog.action(tr('设置本库 Git 身份','Set library Git identity'),async()=>{
				await editRepositoryIdentity(plugin,lib);dialog.close();
			});
			const partial=new Set(staged.filter(c=>c.work!==c.stage).map(c=>c.file));
			const mark=(file:string)=>partial.has(file)?' · '+tr('部分暂存','Partially staged'):'';
			dialog.contentEl.createEl('h3',{text:(preview.staged?tr('本次提交的暂存内容','Staged changes in this commit'):tr('将暂存并提交','Changes to stage and commit'))+' ('+included.length+')'});
			dialog.lines(included.map(c=>c.file+' · '+state(preview.staged?c.head:c.stage,preview.staged?c.stage:c.work)+mark(c.file)));
			if(preview.staged && working.length){
				dialog.contentEl.createEl('h3',{text:tr('留在工作区的更改','Changes kept in the working tree')+' ('+working.length+')'});
				dialog.lines(working.map(c=>c.file+' · '+state(c.stage,c.work)+mark(c.file)));
			}
			const label=commitMode==='amend'?tr('修订上一次提交','Amend previous commit'):preview.staged?tr('提交已暂存内容','Commit staged changes'):tr('暂存并提交','Stage and commit');
			dialog.action(label,async()=>{
				const oid=await plugin.exclusiveGit(lib.location,async()=>{
					await recheck(plugin.disk,plugin.config,lib);
					const complete=prefs.listChangedFilesInMessageBody && message.trim()?message+'\n\n'+files.map(file=>'- '+file).join('\n'):message;
					return saveVersion(dir,preview,complete,async receipt=>{
						if(!lib.identity)throw new Error(tr('库身份已失效',"Library identity is no longer valid"));
						plugin.saves[lib.identity.id]=receipt;
						await plugin.persist();
					},commitMode);
				});
				dialog.contentEl.empty();dialog.lines([lib.location,tr('已提交 ',"Committed ")+oid]);
				await onCommitted?.();await plugin.refresh();
			});
		}else dialog.lines([tr('没有待提交内容',"No changes to commit")]);
		const scan=dialog.contentEl.createEl('details');
		scan.createEl('summary',{text:tr('扫描详情','Scan details')});
		scan.createEl('p',{text:preview.platform+tr(' · 已扫描 ',' · Scanned ')+preview.files+tr(' 个文件，读取 ',' files and ')+preview.bytes+tr(' 字节，用时 ',' bytes in ')+preview.elapsed+' ms'});
	}
	dialog.open();
}

function state(before:number,after:number){
	if(before===after)return tr('无变化',"unchanged");
	return after===0?tr('删除',"deleted"):before===0?tr('新增',"added"):tr('修改',"modified");
}

export async function activeVersion(plugin: KnowledgeBaseManager, mode:'save'|'history'){
	const libs=(await discover(plugin.disk,plugin.config)).filter(l=>l.identity && !l.problem && !l.duplicate);
	const file=plugin.app.workspace.getActiveFile()?.path;
	const target=file ? libs.find(l=>file.startsWith(l.location+'/')) : undefined;
	if(target){await versions(plugin,target,mode);return;}
	const selector=new Dialog(plugin.app,tr('选择目标知识库',"Select knowledge base"));
	for(const lib of libs)selector.action(lib.location,async()=>{selector.close();await versions(plugin,lib,mode);});
	if(!libs.length)selector.lines([tr('没有可选的知识库，请检查管理器中的冲突或发现结果。',"No eligible libraries. Review conflicts and discovered libraries in the manager.")]);
	selector.open();
}
