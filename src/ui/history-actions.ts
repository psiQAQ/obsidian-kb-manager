import { Menu, Setting } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import type { GraphRef } from '../git/history-graph.ts';
import { createGraphBranch, createGraphTag, deleteGraphTag, graphTagDetails, renameGraphBranch, requireGraphCommit } from '../git/graph-ref-actions.ts';
import { applyGraphStash, graphStashPlan, graphStashSavePlan, saveGraphStash } from '../git/graph-stash-actions.ts';
import { readRepositoryIdentity } from '../git/identity.ts';
import { applyChange, changePlan, refName } from '../git/network.ts';
import { deletionPlan, removeBranch } from '../git/network-refs.ts';
import { gitResult } from '../git/network-native.ts';
import { assertGitEnabled, pluginNotice } from './device.ts';
import { Dialog } from './dialog.ts';
import { addAdvancedHistoryActions, reviewHistoryAttach } from './history-advanced.ts';
import { addHistoryRemoteActions } from './history-remote-actions.ts';
import { commitRoles } from './repository-identity.ts';

interface HistoryMenuOptions {
	plugin:KnowledgeBaseManager;
	lib:Library;
	dir:string;
	commit?:{oid:string;message:string};
	ref?:GraphRef;
	stash?:boolean;
	detached?:boolean;
	event?:MouseEvent;
	anchor?:HTMLElement;
	showRefs?:()=>void;
	openComparison?:(oid:string)=>void;
	selectBase?:(oid:string)=>void;
}

export function showHistoryMenu(options:HistoryMenuOptions){
	const {plugin,lib,dir,commit,ref,event,anchor,openComparison,selectBase,showRefs}=options,t=plugin.t;
	const id=lib.identity?.id;
	if(!id || (!event && !anchor))return;
	const menu=new Menu(),oid=ref?.oid??commit?.oid;
	const add=(text:string,icon:string,action:()=>unknown)=>menu.addItem(item=>item.setTitle(text).setIcon(icon).onClick(()=>{
		void Promise.resolve().then(action).catch((error:unknown)=>pluginNotice(plugin,'error',String(error),id,8000));
	}));
	const modal=(title:string)=>{
		const form=new Dialog(plugin.app,title);
		form.facts([[t('知识库','Library'),lib.location]]);
		return form;
	};
	const check=async()=>{
		assertGitEnabled(plugin);
		const current=await recheck(plugin.disk,plugin.config,lib);
		const folder=await plugin.disk.path(current.location);
		if(folder!==dir)throw new Error(t('知识库路径已变化，请重新打开历史','The library path changed. Reopen its history.'));
		return current;
	};
	const checkWrite=async()=>{
		if((await check()).identity?.archived)throw new Error(t('此知识库已归档','This library is archived.'));
	};
	const mutate=async(form:Dialog,action:()=>Promise<unknown>)=>{
		try{
			await plugin.exclusiveGit(lib.location,async()=>{await checkWrite();await action();});
		}catch(error){
			await plugin.refresh().catch(()=>undefined);
			throw error;
		}
		form.close();await plugin.refresh();
	};
	const confirm=(form:Dialog,label:string,action:()=>Promise<unknown>,warning=false)=>{
		const button=form.action(label,()=>mutate(form,action));
		if(warning)button.setDestructive();
		button.setCta();
		form.action(t('取消','Cancel'),()=>{form.close();return Promise.resolve();});
	};
	const verifyTip=(current:string)=>{
		if(current!==oid)throw new Error(t('引用已移动，请刷新历史并重新预览','The reference moved. Refresh the graph and preview again.'));
	};
	const factsForOid=(form:Dialog,name:string,value:string)=>form.facts([[name,value],[t('提交','Commit'),oid??'']]);

	if(oid){
		add(t('复制完整提交 SHA','Copy full commit SHA'),'copy',()=>navigator.clipboard.writeText(oid));
		if(selectBase)add(t('设为比较基线','Set as comparison base'),'git-compare',()=>selectBase(oid));
		if(openComparison)add(t('比较到此提交','Compare to this commit'),'git-compare',()=>openComparison(oid));
	}else if(openComparison)add(t('比较到工作区','Compare to working tree'),'git-compare',()=>openComparison('worktree'));
	if(commit?.message)add(t('复制提交标题','Copy commit subject'),'copy',()=>navigator.clipboard.writeText(commit.message.split('\n')[0]??''));
	if(showRefs)add(t('引用操作…','Ref actions…'),'git-branch',showRefs);
	if(ref){
		add(t('复制完整引用名','Copy full reference name'),'copy',()=>navigator.clipboard.writeText(ref.ref));
		if(ref.kind==='tag' && ref.tagOid)add(t('查看标签注释','View tag annotation'),'tag',async()=>{
			await check();
			const info=await graphTagDetails(dir,ref);
			const form=modal(t('标签注释','Tag annotation'));
			factsForOid(form,t('标签','Tag'),ref.name);
			if(info?.tagger)form.facts([[t('标签署名','Tagger'),info.tagger]]);
			if(info?.message)form.contentEl.createEl('pre',{cls:'kb-commit-body',text:info.message});
			form.open();
		});
	}
	if(!lib.identity?.archived && options.detached && ref?.kind==='local'){
		menu.addSeparator();
		add(t('切回此本地分支','Reattach to this local branch'),'git-branch',()=>reviewHistoryAttach(plugin,lib,dir,ref));
	}
	if(!lib.identity?.archived && !options.detached){
		menu.addSeparator();
		const manager=async(icon?:string)=>{
			await checkWrite();
			const view=await plugin.openManager();
			if(icon)await view.runNetworkAction(id,icon);
			else await view.showLibrary(id);
		};
		if(!ref){
			add(t('打开本库更改','Open library changes'),'files',()=>manager());
			add(t('管理本库分支','Manage library branches'),'git-branch',()=>manager('git-branch'));
			add(t('获取本库上游','Fetch library upstream'),'cloud-download',()=>manager('cloud-download'));
			add(t('管理本库远端','Manage library remotes'),'settings-2',()=>manager('settings-2'));
		}
		if(oid && ref?.kind!=='stash' && (ref || !options.stash)){
			add(t('从此提交创建分支','Create branch from this commit'),'git-branch',async()=>{
				await checkWrite();await requireGraphCommit(dir,oid);
				const label=t('创建本地分支','Create local branch'),form=modal(label);let name='';
				form.facts([[t('起点提交','Starting commit'),oid]]);
				form.text(t('新分支名','New branch name'),'',v=>{name=v;});
				confirm(form,label,()=>createGraphBranch(dir,name.trim(),oid));form.open();
			});
			add(t('在此提交创建标签','Create tag at this commit'),'tag',async()=>{
				await checkWrite();await requireGraphCommit(dir,oid);
				const label=t('创建本地标签','Create local tag'),form=modal(label);let name='',message='';
				const {identity}=await readRepositoryIdentity(dir);
				form.facts([[t('提交','Commit'),oid],[t('注释标签的署名','Annotated tagger'),identity.name+' <'+identity.email+'>']]);
				form.text(t('标签名','Tag name'),'',v=>{name=v;});
				form.multiline(t('注释（留空创建轻量标签）','Annotation (leave blank for a lightweight tag)'),'',v=>{message=v;});
				confirm(form,label,()=>createGraphTag(dir,name.trim(),oid,message,identity));form.open();
			});
		}
		if(ref?.kind==='local'){
			add(t('重命名本地分支','Rename local branch'),'pencil',async()=>{
				await checkWrite();
				const label=t('重命名本地分支','Rename local branch'),form=modal(label);let name=ref.name;
				factsForOid(form,t('当前名称','Current name'),ref.name);
				form.text(t('新名称','New name'),name,v=>{name=v;});
				confirm(form,label,()=>renameGraphBranch(dir,ref.ref,ref.oid,name.trim()));form.open();
			});
			add(t('删除已合入的本地分支','Delete merged local branch'),'trash-2',async()=>{
				await checkWrite();
				const plan=await deletionPlan(dir,ref.name);verifyTip(plan.tip);
				const label=t('删除本地分支','Delete local branch'),form=modal(label);
				factsForOid(form,t('将删除的分支','Branch to delete'),plan.branch);
				form.facts([[t('已合入分支','Merged into'),plan.current+' · '+plan.head]]);
				confirm(form,label,()=>removeBranch(dir,plan),true);form.open();
			});
		}
		if(ref?.kind==='local' || ref?.kind==='remote'){
			const branchOperation=(action:'switch'|'merge'|'rebase',label:string,icon:string)=>add(label,icon,async()=>{
				await checkWrite();
				const plan=await changePlan(dir,ref.ref);verifyTip(plan.oid);
				if(action!=='switch' && (plan.ref==='refs/heads/'+plan.branch || plan.oid===plan.head))
					throw new Error(t('当前分支已位于此提交','The current branch already points at this commit.'));
				if(action==='rebase'){
					const protectedChanges=(await gitResult(dir,['log','--format=%H','--full-history',plan.oid+'..'+plan.head,'--','kb.toml','kb-manager.json','.gitattributes'])).stdout;
					if(protectedChanges.length)throw new Error(t('变基将重放库清单或 Git 属性的修改，请在外部核对','The rebase would replay changes to the library manifest or Git attributes. Review externally.'));
				}
				const form=modal(label);
				form.facts([[t('当前分支','Current branch'),plan.branch+' · '+plan.head],[t('目标引用','Target reference'),ref.ref+' · '+plan.oid]]);
				if(action!=='switch')form.lines([...commitRoles(plan.identity,action),...(action==='rebase'?[t('变基会改写当前分支的提交。','Rebasing rewrites commits on the current branch.')]:[])]);
				form.lines(plan.changes);
				confirm(form,label,()=>applyChange(dir,plan,action==='switch'?'switch':'pull',action==='switch'?'ff-only':action));form.open();
			});
			if(ref.kind==='local')branchOperation('switch',t('切换到此本地分支','Switch to this local branch'),'git-branch');
			branchOperation('merge',t('合并到当前分支','Merge into current branch'),'git-merge');
			branchOperation('rebase',t('将当前分支变基到此处','Rebase current branch onto this ref'),'git-pull-request');
		}
		if(ref?.kind==='tag'){
			add(t('删除本地标签','Delete local tag'),'trash-2',async()=>{
				await checkWrite();await graphTagDetails(dir,ref);
				const label=t('删除本地标签','Delete local tag'),form=modal(label);
				factsForOid(form,t('将删除的标签','Tag to delete'),ref.name);
				confirm(form,label,()=>deleteGraphTag(dir,ref),true);form.open();
			});
		}
		addHistoryRemoteActions({plugin,id,dir,ref,add,modal,confirm,checkWrite});
		if(!oid) add(t('贮藏未提交的改动','Stash uncommitted changes'),'archive',async()=>{
			await checkWrite();
			const edit=(include=false,message='')=>{
				const form=modal(t('贮藏未提交的改动','Stash uncommitted changes'));
				new Setting(form.contentEl).setName(t('包含未跟踪的文件','Include untracked files'))
					.addToggle(toggle=>toggle.setValue(include).onChange(value=>{include=value;}));
				form.text(t('贮藏说明','Stash message'),message,value=>{message=value;});
				form.action(t('预览贮藏','Preview stash'),async()=>{
					const untracked=include,description=message;
					const plan=await graphStashSavePlan(dir,untracked);
					const label=t('贮藏这些改动','Stash these changes'),review=modal(label);
					review.facts([[t('当前分支','Current branch'),plan.branch+' · '+plan.head]]);review.lines(plan.files);
					review.action(t('返回编辑','Back to edit'),()=>{review.close();edit(untracked,description);return Promise.resolve();});
					confirm(review,label,()=>saveGraphStash(dir,plan,description));form.close();review.open();
				}).setCta();form.open();
			};
			edit();
		});
		if(ref?.kind==='stash'){
			const labels={apply:t('应用贮藏','Apply stash'),pop:t('应用并移除贮藏','Pop stash'),drop:t('删除贮藏','Drop stash'),branch:t('从贮藏创建分支','Create branch from stash')};
			for(const action of ['apply','pop','drop','branch'] as const)add(labels[action],action==='drop'?'trash-2':action==='branch'?'git-branch':'archive',async()=>{
				await checkWrite();
				const plan=await graphStashPlan(dir,ref,action),form=modal(labels[action]);let name='';
				factsForOid(form,t('贮藏','Stash'),ref.ref);
				if(plan.branch)form.facts([[t('当前分支','Current branch'),plan.branch+' · '+plan.head]]);
				if(plan.base)form.facts([[t('贮藏基线','Stash base'),plan.base]]);
				if(plan.files.length)form.lines(plan.files);
				if(action==='branch'){
					form.lines([t('将切换到新分支并恢复改动，贮藏条目保留。','Switch to the new branch and restore the changes. The stash entry is kept.')]);
					form.text(t('新分支名称','New branch name'),'',v=>{name=v;});
				}
				confirm(form,labels[action],()=>applyGraphStash(dir,plan,action==='branch'?refName(name.trim()):undefined),action==='drop');form.open();
			});
		}
	}
	addAdvancedHistoryActions(menu,options);
	event?.preventDefault();
	if(event)menu.showAtMouseEvent(event);
	else if(anchor){const rect=anchor.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.bottom},anchor.ownerDocument);}
}
