import type KnowledgeBaseManager from '../main.ts';
import type { GraphRef } from '../git/history-graph.ts';
import { fetchGraphBranch, graphRemoteTarget, graphTagDetails, pushGraphTag, trackGraphBranch } from '../git/graph-ref-actions.ts';
import { deleteGraphRemoteReference, graphPrunePlan, graphRemoteDeletion, pruneGraphRemote } from '../git/graph-remote-actions.ts';
import { remoteState } from '../git/network.ts';
import type { RemoteTarget } from '../git/network.ts';
import type { Dialog } from './dialog.ts';
import { credential } from './network.ts';

interface RemoteActions {
	plugin:KnowledgeBaseManager;
	id:string;
	dir:string;
	ref?:GraphRef;
	add:(text:string,icon:string,act:()=>unknown)=>unknown;
	modal:(title:string)=>Dialog;
	confirm:(form:Dialog,label:string,action:()=>Promise<unknown>)=>unknown;
	checkWrite:()=>Promise<void>;
}

export function addHistoryRemoteActions({plugin,id,dir,ref,add,modal,confirm,checkWrite}:RemoteActions){
	const t=plugin.t;
	const checkPush=()=>{
		if(plugin.preferences(id).disablePush)throw new Error(t('本库已禁用推送','Push is disabled for this library.'));
	};
	const chooseRemote=async(label:string,preview:(target:RemoteTarget)=>Promise<void>)=>{
		await checkWrite();
		const state=await remoteState(dir);
		if(!state.remotes.length)throw new Error(t('请先配置本库远端','Configure a library remote first.'));
		const form=modal(label);
		if(ref)form.facts([[t('选中的完整引用','Selected full reference'),ref.ref+' · '+ref.oid]]);
		for(const {remote} of state.remotes)form.action(remote,async()=>{
			await preview(await graphRemoteTarget(dir,remote,state.preview.branch));form.close();
		});
		form.open();
	};
	const pruneLabel=t('清理失效的本地跟踪引用','Prune stale tracking refs');
	const previewPrune=async(target:RemoteTarget)=>{
		const plan=await graphPrunePlan(dir,target,credential(plugin,id,target)),form=modal(pruneLabel);
		form.facts([[t('远端','Remote'),target.remote],[t('获取地址','Fetch address'),target.fetchDisplay]]);
		if(!plan.refs.length)form.lines([t('没有失效的跟踪引用。','There are no stale tracking refs.')]);
		else{
			form.lines(plan.refs.map(item=>item.ref+' · '+item.oid));
			confirm(form,pruneLabel,()=>pruneGraphRemote(dir,plan,credential(plugin,id,target)));
		}
		form.open();
	};
	if(!ref)add(pruneLabel,'list-filter',()=>chooseRemote(pruneLabel,previewPrune));
	const previewDeletion=async(target:RemoteTarget,fullRef:string,oid:string,label:string)=>{
		checkPush();
		const plan=await graphRemoteDeletion(dir,target,fullRef,oid,credential(plugin,id,target,true)),form=modal(label);
		form.facts([[t('远端','Remote'),target.remote],[t('推送地址','Push address'),target.pushDisplay],
			[t('将从服务器删除的引用','Reference to remove from server'),plan.ref+' · '+plan.oid]]);
		confirm(form,label,async()=>{checkPush();await deleteGraphRemoteReference(dir,plan,credential(plugin,id,target,true));});form.open();
	};
	if(ref?.kind==='remote'){
		const target=async()=>{
			await checkWrite();
			const {remotes}=await remoteState(dir);
			const remote=remotes.find(item=>ref.ref.startsWith('refs/remotes/'+item.remote+'/'));
			if(!remote)throw new Error(t('此跟踪引用没有对应的远端配置','No configured remote matches this tracking ref.'));
			return graphRemoteTarget(dir,remote.remote,ref.ref.slice(('refs/remotes/'+remote.remote+'/').length));
		};
		add(t('获取此远端分支','Fetch this remote branch'),'cloud-download',async()=>{
			const remote=await target(),label=t('获取此远端分支','Fetch this remote branch'),form=modal(label);
			form.facts([[t('获取地址','Fetch address'),remote.fetchDisplay],[t('完整分支引用','Full branch ref'),'refs/heads/'+remote.remoteBranch]]);
			confirm(form,label,()=>fetchGraphBranch(dir,remote,credential(plugin,id,remote)));form.open();
		});
		add(t('创建本地跟踪分支','Create local tracking branch'),'git-branch',async()=>{
			const remote=await target(),label=t('创建本地跟踪分支','Create local tracking branch'),form=modal(label);let name=remote.remoteBranch;
			form.facts([[t('跟踪引用','Tracking ref'),ref.ref+' · '+ref.oid]]);
			form.text(t('本地分支名','Local branch name'),name,v=>{name=v;});
			confirm(form,label,()=>trackGraphBranch(dir,ref.ref,ref.oid,remote.remote,name.trim()));form.open();
		});
		add(pruneLabel,'list-filter',async()=>previewPrune(await target()));
		if(!plugin.preferences(id).disablePush){
			const deletion=t('从服务器删除此分支','Delete this branch on the server');
			add(deletion,'trash-2',async()=>{
				const destination=await target();
				await previewDeletion(destination,'refs/heads/'+destination.remoteBranch,ref.oid,deletion);
			});
		}
	}
	if(ref?.kind==='tag' && !plugin.preferences(id).disablePush){
		const push=t('推送此标签','Push this tag'),deletion=t('从服务器删除此标签','Delete this tag on the server');
		add(push,'cloud-upload',()=>chooseRemote(push,async target=>{
			checkPush();await graphTagDetails(dir,ref);
			const form=modal(push);
			form.facts([[t('标签引用','Tag ref'),ref.ref+' · '+(ref.tagOid??ref.oid)],[t('推送地址','Push address'),target.pushDisplay]]);
			form.lines([t('推送会发送标签指向的尚未发布的提交及其历史。','Push sends unpublished history reachable from this tag.')]);
			confirm(form,push,async()=>{checkPush();await pushGraphTag(dir,ref,target,credential(plugin,id,target,true));});form.open();
		}));
		add(deletion,'trash-2',()=>chooseRemote(deletion,target=>previewDeletion(target,ref.ref,ref.tagOid??ref.oid,deletion)));
	}
}
