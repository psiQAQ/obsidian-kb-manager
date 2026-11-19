import { pluginNotice } from './device.ts';
import { squash,squashPreview } from '../git/squash.ts';


import type { CommitMode } from '../git/versions.ts';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { recheck } from '../kb/catalog.ts';
import { resolveRef, applyChange, changePlan, remoteState, transfer } from '../git/network.ts';
import { Dialog } from './dialog.ts';
import { credential, recordPull } from './network.ts';
import { versions } from './versions.ts';

export async function commitAndSync(plugin:KnowledgeBaseManager,lib:Library,draft?:string,onCommitted?:()=>void,mode:CommitMode='smart',onComplete?:()=>void){
	const id=lib.identity?.id,t=plugin.t;
	if(!id || lib.identity?.archived)throw new Error(t('请选择活动知识库','Select an active library'));
	await recheck(plugin.disk,plugin.config,lib);
	const dir=await plugin.disk.path(lib.location);
	const first=await remoteState(dir),prefs=plugin.preferences(id),target=first.target;
	if(!prefs.pullBeforePush && prefs.disablePush){
		if(first.preview.changes.length)await versions(plugin,lib,'save',draft,()=>{onCommitted?.();onComplete?.();},mode);
		else {pluginNotice(plugin,'unchanged',t('没有待同步的更改','No changes to sync'),id);onComplete?.();}
		return;
	}
	if(!target)throw new Error(t('请先设置本库的上游','Configure the library upstream first'));
	const upstream=target;
	const run=<T>(action:()=>Promise<T>)=>plugin.exclusiveGit(lib.location,async()=>{
		await recheck(plugin.disk,plugin.config,lib);
		const current=await remoteState(dir);
		if(current.preview.branch!==first.preview.branch || JSON.stringify(current.target)!==JSON.stringify(upstream))throw new Error(t('分支或远端已变化','Branch or upstream changed'));
		return action();
	});
	async function confirmPush(inspected=false){
		if(prefs.disablePush){onComplete?.();return;}
		if(prefs.squashCommitsBeforePush && !inspected){
			const inspect=new Dialog(plugin.app,t('检查待推送的提交','Inspect outgoing commits'));
			inspect.lines([lib.location,upstream.fetchDisplay,upstream.remoteBranch]);
			inspect.action(t('获取上游并预览','Fetch upstream and preview'),async()=>{
				const plan=await run(async()=>{
					await transfer(dir,'fetch',upstream,credential(plugin,id!,upstream));
					const base=await resolveRef(dir,'refs/remotes/'+upstream.remote+'/'+upstream.remoteBranch);
					return squashPreview(dir,base);
				});
				inspect.close();
				if(plan.commits.length<2){await confirmPush(true);return;}
				const review=new Dialog(plugin.app,t('压缩待推送的提交','Squash outgoing commits'));
				review.lines([lib.location,plan.branch,...plan.commits.map(c=>c.oid.slice(0,10)+' · '+c.message),
					'refs/kb-manager/before-squash/'+plan.head]);
				let message=plan.commits.map(c=>c.message).reverse().join(' / ');
				review.text(t('合并后的提交说明','Squashed commit message'),message,value=>{message=value;});
				review.action(t('压缩并预览推送','Squash and preview push'),async()=>{
					await run(()=>squash(dir,plan,message));
					review.close();await confirmPush(true);
				});
				review.action(t('保留这些提交并预览推送','Keep commits and preview push'),async()=>{review.close();await confirmPush(true);});
				review.open();
			});
			inspect.action(t('直接预览推送','Preview push without squashing'),async()=>{inspect.close();await confirmPush(true);});
			inspect.open();return;
		}
		const state=await run(()=>remoteState(dir));
		const dialog=new Dialog(plugin.app,t('确认推送本库','Confirm library push'));
		dialog.lines([lib.location,state.preview.branch+' · '+state.preview.head,upstream.pushDisplay+' → '+upstream.remoteBranch]);
		dialog.action(t('推送','Push'),async()=>{
			await run(async()=>{
				if((await remoteState(dir)).preview.head!==state.preview.head)throw new Error(t('提交已变化','Commit changed'));
				await transfer(dir,'push',upstream,credential(plugin,id!,upstream,true));
			});
			dialog.close();await plugin.refresh();pluginNotice(plugin,'info',t('已推送','Pushed')+' · '+lib.location,id);onComplete?.();
		});dialog.open();
	}
	async function synchronize(){
		if(!prefs.pullBeforePush){await confirmPush();return;}
		const fetch=new Dialog(plugin.app,t('获取并预览拉取','Fetch and preview pull'));
		fetch.lines([lib.location,upstream.fetchDisplay+' → '+upstream.remoteBranch]);
		fetch.action(t('获取','Fetch'),async()=>{
			const plan=await run(async()=>{
				await transfer(dir,'fetch',upstream,credential(plugin,id!,upstream));
				return changePlan(dir,'refs/remotes/'+upstream.remote+'/'+upstream.remoteBranch);
			});
			fetch.close();
			const pull=new Dialog(plugin.app,t('确认本库拉取','Confirm library pull'));
			pull.lines([lib.location,plan.branch+' · '+plan.head.slice(0,10)+' → '+plan.oid.slice(0,10),prefs.syncMethod+' · '+prefs.mergeStrategy,...plan.changes]);
			pull.action(t('继续','Continue'),async()=>{
				await run(()=>applyChange(dir,plan,'pull',prefs.syncMethod,prefs.mergeStrategy));
				recordPull(plugin,id!,plan.changes);pull.close();await plugin.refresh();await confirmPush();
			});pull.open();
		});fetch.open();
	}
	if(first.preview.changes.length){
		await versions(plugin,lib,'save',draft,async()=>{onCommitted?.();await synchronize();},mode);
	}else await synchronize();
}
