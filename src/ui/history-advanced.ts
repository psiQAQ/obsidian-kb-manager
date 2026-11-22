import {Menu,Notice} from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import {recheck} from '../kb/catalog.ts';
import type {Library} from '../kb/catalog.ts';
import {advancedPreview,applyAdvanced} from '../git/history-advanced.ts';
import type {AdvancedAction,AdvancedRequest} from '../git/history-advanced.ts';
import {activeOperation} from '../git/graph-recovery.ts';
import {hostingLinks} from '../git/hosting-links.ts';
import {localConfig,remoteState} from '../git/network.ts';
import {fields,headOid,readCommit} from '../git/repository.ts';
import type {GraphRef} from '../git/history-graph.ts';
import {gitResult} from '../git/network-native.ts';
import {Dialog} from './dialog.ts';
import {credential} from './network.ts';
import {assertGitEnabled} from './device.ts';

interface Context {
	plugin:KnowledgeBaseManager;lib:Library;dir:string;commit?:{oid:string;message:string};ref?:GraphRef;stash?:boolean;
}
const names:Record<AdvancedAction,[string,string]>={
	'cherry-pick':['摘取此提交','Cherry-pick commit'],revert:['用新提交撤销此提交','Revert commit'],drop:['从当前分支丢弃此提交','Drop commit from current branch'],
	soft:['重置分支，保留暂存与工作区','Soft reset'],mixed:['重置分支和暂存区','Mixed reset'],hard:['硬重置分支、索引和工作区','Hard reset'],
	detach:['分离 HEAD 检出此版本','Check out detached'],attach:['重新切换到本地分支','Reattach local branch'],clean:['清理未跟踪文件','Clean untracked files'],
	restore:['从此版本恢复文件和暂存内容','Restore file and index from revision'],'force-push':['带租约强制推送至本库上游','Force push to upstream with lease'],
	continue:['继续当前 Git 操作','Continue operation'],abort:['中止当前 Git 操作','Abort operation'],resolve:['将编辑结果标记为已解决','Mark resolution as staged']
};
async function writable({plugin,lib,dir}:Context){
	assertGitEnabled(plugin);
	const current=await recheck(plugin.disk,plugin.config,lib);
	if(!current.identity || current.identity.id!==lib.identity?.id || current.identity.archived || await plugin.disk.path(current.location)!==dir)
		throw new Error(plugin.t('库身份已变化或已归档','Library identity changed or is archived'));
}
async function review(ctx:Context,request:AdvancedRequest,parent?:Dialog){
	const {plugin,dir,lib}=ctx,t=plugin.t;
	await writable(ctx);
	const auth=async()=>{
		if(request.action!=='force-push')return;
		if(await headOid(dir)!==request.oid)throw new Error(t('HEAD 已移动，请刷新历史并重新预览','HEAD moved. Refresh history and preview again.'));
		const {target}=await remoteState(dir);
		if(plugin.preferences(lib.identity!.id).disablePush)throw new Error(t('本库设置已关闭推送','Push is disabled for this library'));
		return target?credential(plugin,lib.identity!.id,target,true):undefined;
	};
	const plan=await advancedPreview(dir,request,await auth());
	if(request.action==='force-push' && plan.head!==request.oid)
		throw new Error(t('HEAD 已移动，请刷新历史并重新预览','HEAD moved. Refresh history and preview again.'));
	const label=t(...names[request.action]),dialog=new Dialog(plugin.app,label);
	dialog.facts([[t('知识库','Library'),lib.location],['HEAD',plan.branch+' · '+plan.head],
		...(plan.op?[[t('进行中','In progress'),plan.op] as const]:[])]);
	for(const [title,items] of [[t('引用','References'),plan.refs],[t('涉及的提交','Commits'),plan.commits],
		[t('将从该分支移出的提交','Commits leaving this branch'),plan.leaving],[t('将进入该分支的提交','Commits entering this branch'),plan.entering],
		[t('暂存区路径','Index paths'),plan.indexPaths],[t('工作区路径','Working tree paths'),plan.workPaths]] as const){
		if(!items.length)continue;
		dialog.contentEl.createEl('h4',{text:title+' ('+items.length+')'});dialog.lines(items);
	}
	const confirm=dialog.action(t('确认执行','Confirm')+' · '+label,async()=>{
		try{
			await plugin.exclusiveGit(lib.location,async()=>{
				await writable(ctx);await applyAdvanced(dir,plan,await auth());
			});
		}catch(error){
			if(!plan.op && await activeOperation(dir)){
				dialog.close();parent?.close();await plugin.refresh();
				new Notice(t('Git 操作等待解决冲突。请在历史图打开「提交与恢复操作」。','Resolve the conflicts using Commit and recovery actions in the graph.'));
			}
			throw error;
		}
		dialog.close();parent?.close();await plugin.refresh();
	});
	if(['hard','drop','clean','force-push'].includes(request.action))confirm.setDestructive();
	confirm.setCta();
	dialog.action(parent?t('返回','Back'):t('取消','Cancel'),()=>{dialog.close();return Promise.resolve();});
	dialog.open();
}
export async function reviewHistoryRestore(plugin:KnowledgeBaseManager,lib:Library,dir:string,oid:string,file:string){
	await review({plugin,lib,dir},{action:'restore',file,oid});
}
export async function reviewHistoryAttach(plugin:KnowledgeBaseManager,lib:Library,dir:string,ref:GraphRef){
	await review({plugin,lib,dir,ref},{action:'attach',ref:ref.ref,oid:ref.oid});
}
async function actions(ctx:Context){
	const {plugin,dir,commit,ref}=ctx,t=plugin.t;
	await writable(ctx);
	const dialog=new Dialog(plugin.app,t('提交与恢复操作','Commit and recovery actions'));
	const add=(request:AdvancedRequest,label=t(...names[request.action])+'…')=>dialog.action(label,()=>review(ctx,request,dialog));
	const op=await activeOperation(dir);
	if(op){
		dialog.facts([[t('进行中','In progress'),op]]);
		const conflicts=fields((await gitResult(dir,['diff','--name-only','--diff-filter=U','-z','--'])).stdout);
		for(const file of conflicts)add({action:'resolve',file},t('标记已解决','Stage resolution')+' · '+file);
		if(!conflicts.length)add({action:'continue'});
		add({action:'abort'});
	}else{
		const current=(await gitResult(dir,['symbolic-ref','-q','HEAD'],{allowedExitCodes:[0,1]})).stdout.toString().trimEnd();
		if(!current){
			const branches=(await gitResult(dir,['for-each-ref','--format=%(objectname) %(refname)','refs/heads/'])).stdout.toString().trimEnd();
			for(const line of branches.split('\n').filter(Boolean)){
				const [oid,branch]=line.trimEnd().split(' ');
				add({action:'attach',ref:branch!,oid:oid!},t('切回分支','Reattach')+' · '+branch!.slice(11));
			}
		}else if(ref?.kind==='stash' || (!ref && ctx.stash)){
			dialog.lines([t('可通过此贮藏的引用菜单管理贮藏。','Use this stash’s ref menu to manage it.')]);
		}else if(commit || ref){
			const oid=ref?.oid??commit!.oid,fullRef=ref?.ref.startsWith('refs/') && ref.ref!=='refs/stash'?ref.ref:undefined;
			const {commit:record}=await readCommit(dir,oid);
			let mainline=1;
			if(record.parent.length>1)dialog.choice(t('摘取或撤销时的主线父提交','Mainline for cherry-pick or revert'),
				Object.fromEntries(record.parent.map((p,i)=>[String(i+1),(i+1)+' · '+p.slice(0,10)])),value=>{mainline=Number(value);});
			for(const action of ['cherry-pick','revert','drop','soft','mixed','hard','detach'] as const){
				dialog.action(t(...names[action])+'…',()=>review(ctx,{action,oid,ref:fullRef,mainline},dialog));
			}
			if((!ref || ref.ref===current) && oid===await headOid(dir) && !plugin.preferences(ctx.lib.identity!.id).disablePush)
				add({action:'force-push',oid,ref:fullRef});
		}else add({action:'clean'});
	}
	dialog.action(t('取消','Cancel'),()=>{dialog.close();return Promise.resolve();});
	dialog.open();
}
export async function openHistoryRecovery(plugin:KnowledgeBaseManager,lib:Library,dir:string){
	await actions({plugin,lib,dir});
}
async function hosting(ctx:Context){
	const {plugin,dir,ref,commit,lib}=ctx,t=plugin.t;
	await recheck(plugin.disk,plugin.config,lib);
	const settings=await localConfig(dir);
	const head=(await gitResult(dir,['symbolic-ref','--quiet','--short','HEAD'],{allowedExitCodes:[0,1]})).stdout.toString().trim();
	const tracking=ref?.ref.startsWith('refs/remotes/')?ref.ref.slice(13):'';
	const slash=tracking.indexOf('/');
	const branch=slash>=0?tracking.slice(slash+1):ref?.ref.startsWith('refs/heads/')?ref.ref.slice(11):head;
	const upstream=slash>=0?tracking.slice(0,slash):settings.find(([key])=>key==='branch.'+branch+'.remote')?.[1]??'origin';
	const remote=settings.find(([key])=>key==='remote.'+upstream+'.url')?.[1];
	const links=remote?hostingLinks(remote,branch,commit?.message):[];
	if(!links.length)throw new Error(t('此分支没有可打开的托管平台链接','No hosting links available for this branch'));
	const dialog=new Dialog(plugin.app,t('打开托管平台网页','Open repository website'));
	dialog.facts([[t('知识库','Library'),lib.location],[t('远端','Remote'),upstream],[t('分支','Branch'),branch]]);
	for(const link of links)dialog.contentEl.createEl('a',{text:link.label+' · '+link.url,href:link.url,attr:{target:'_blank',rel:'noopener noreferrer'}}).addClass('kb-history-host-link');
	dialog.open();
}
export function addAdvancedHistoryActions(menu:Menu,ctx:Context){
	const add=(label:string,run:()=>Promise<void>)=>menu.addItem(item=>item.setTitle(label).onClick(()=>{void run().catch(error=>new Notice(String(error)));}));
	menu.addSeparator();
	if(!ctx.lib.identity?.archived)add(ctx.plugin.t('提交与恢复操作…','Commit and recovery actions…'),()=>actions(ctx));
	add(ctx.plugin.t('PR 与议题网页…','Pull request and issue links…'),()=>hosting(ctx));
}
