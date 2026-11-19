import { moment } from 'obsidian';
import { hostname } from 'node:os';
import { renderCommitMessage } from '../preferences.ts';
import { tr } from '../i18n.ts';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { previewVersion, saveVersion } from '../git/versions.ts';
import type { CommitMode } from '../git/versions.ts';
import { initializeRepository,readCommit } from '../git/repository.ts';
import { showSourceHistory } from './source-history.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled } from './device.ts';
import { editRepositoryIdentity } from './repository-identity.ts';

export async function versions(plugin: KnowledgeBaseManager, lib: Library, mode:'save'|'history', draft?: string, onCommitted?:()=>void|Promise<void>, commitMode:CommitMode='smart') {
	assertGitEnabled(plugin);
	await recheck(plugin.disk,plugin.config,lib);
	const dir=await plugin.disk.path(lib.location);
	const prefs=plugin.preferences(lib.identity?.id);
	if(commitMode==='smart' && !prefs.autoStageOnEmptyIndex)commitMode='staged';
	const dialog=new Dialog(plugin.app,mode==='save'?tr('保存本库版本',"Save library version"):tr('本库历史',"Library history"));
	dialog.lines([lib.identity?.displayName ?? '',lib.location]);
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
		if(commitMode==='amend') {
			if(!preview.head)throw new Error(tr('没有可修订的提交','No commit to amend'));
			const {commit}=await readCommit(dir,preview.head);
			dialog.lines([tr('此操作将用当前暂存内容替换最后一个提交。原提交 ID：','This will replace the last commit using the current index. Original commit ID: ')+preview.head]);
			dialog.lines([tr('保留原作者：','Original author retained: ')+commit.author.name+' <'+commit.author.email+'>',
				tr('提交者取自下方 Git 身份。','The Git identity below is used for the committer.')]);
		}
		const previous=lib.identity && plugin.saves[lib.identity.id];
		if(previous && !previous.committed)dialog.lines([
			previous.candidate===preview.head?tr('上次提交已写入：',"Previous commit exists: ")+preview.head:tr('上次操作尚未确认完成，当前 HEAD：',"Previous operation is unconfirmed. Current HEAD: ")+(preview.head||tr('空',"empty")),
			tr('上次说明：',"Previous message: ")+previous.message,tr('已记录暂存：',"Recorded staged files: ")+(previous.staged.join('、')||tr('无',"none")),previous.problem??'',
		]);
		dialog.lines([preview.branch+' · '+(preview.head.slice(0,10)||tr('无提交',"No commits")),
			preview.staged?tr('仅提交索引中已暂存的内容；其余工作区变更留待下次保存。',"Commit only the current index. Other working changes stay in the working tree."):tr('将暂存并提交下列变更。已忽略且未跟踪的文件跳过。',"Stage and commit the following changes. Ignored untracked files are skipped."),
			preview.platform+tr(' · 扫描 '," · Scanned ")+preview.files+tr(' 个文件；读取变更内容 '," files, read ")+preview.bytes+tr(' 字节；'," bytes in ")+preview.elapsed+' ms',
			...preview.changes.map(c=>c.file+tr(' · 索引 '," · index: ")+state(c.head,c.stage)+tr(' · 工作区 '," · working tree: ")+(c.stage===3?tr('有其他内容',"different content"):state(c.stage,c.work)))]);
		if(preview.changes.length){
			const files=preview.changes.filter(c=>!preview.staged || c.head!==c.stage).map(c=>c.file);
			let message=draft ?? renderCommitMessage(prefs,moment().format(prefs.commitDateFormat),hostname(),files);
			dialog.text(tr('提交说明',"Commit message"),message,v=>{message=v;});
			if(prefs.listChangedFilesInMessageBody)dialog.lines([tr('以下文件名会附在提交正文中：','These filenames will be appended to the commit body:'),...files]);
			dialog.lines((['name','email'] as const).map(key=>{
				const source=preview.identitySources[key];
				return 'user.'+key+' · '+(source?source.value+' · '+source.scope+' · '+source.origin:tr('未设置','Unset'));
			}));
			if(!preview.identity.name || !preview.identity.email)dialog.action(tr('设置本库 Git 身份','Set library Git identity'),async()=>{
				await editRepositoryIdentity(plugin,lib);dialog.close();
			});
			const label=commitMode==='amend'?tr('修订上一次提交','Amend previous commit'):preview.staged?tr('提交已暂存内容',"Commit staged changes"):tr('保存此版本',"Save version");
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
