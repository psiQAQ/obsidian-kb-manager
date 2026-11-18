import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import git from 'isomorphic-git';
import {repository} from './repository.ts';
import {digest} from '../fs/vault.ts';
import {remoteState,refName} from './network.ts';
import {transport,endpoint} from './network-http.ts';
import type {Credentials,RemoteTarget} from './network.ts';
import {tr,fromEnglish} from '../i18n.ts';
import {updateConfig} from './network-config.ts';

export async function deletionPlan(dir:string,branch:string){
	const {preview}=await remoteState(dir),repo=repository(dir);
	refName(branch);
	if(preview.branch===branch)throw new Error(tr('当前分支无法删除','Cannot delete the current branch'));
	const tip=await git.resolveRef({...repo,ref:'refs/heads/'+branch});
	if(tip!==preview.head && !await git.isDescendent({...repo,oid:preview.head,ancestor:tip}))throw new Error(tr('分支还未合入当前分支','Branch is not merged into the current branch'));
	return {branch,tip,current:preview.branch,head:preview.head,config:digest(await fs.readFile(path.join(repo.gitdir,'config')))};
}
export async function removeBranch(dir:string,plan:Awaited<ReturnType<typeof deletionPlan>>){
	const fresh=await deletionPlan(dir,plan.branch);
	if(JSON.stringify(plan)!==JSON.stringify(fresh))throw new Error(tr('分支已变化','Branch changed'));
	const repo=repository(dir),target='refs/heads/'+plan.branch,current='refs/heads/'+plan.current;
	const locks=new Map<string,fs.FileHandle>();
	try{
		for(const name of ['HEAD',current,target,'packed-refs','config']){
			const file=path.join(repo.gitdir,name+'.lock');await fs.mkdir(path.dirname(file),{recursive:true});
			locks.set(file,await fs.open(file,'wx'));
		}
		if(await git.currentBranch(repo)!==plan.current || await git.resolveRef({...repo,ref:target})!==plan.tip ||
			await git.resolveRef({...repo,ref:current})!==plan.head || digest(await fs.readFile(path.join(repo.gitdir,'config')))!==plan.config)
			throw new Error(tr('分支已变化','Branch changed'));
		await git.deleteBranch({...repo,ref:plan.branch});
	}finally{
		for(const [file,lock] of [...locks].reverse()){await lock.close();await fs.unlink(file);}
	}
}

export async function remoteRemoval(dir:string,remote:string){
	const {remotes,branches}=await remoteState(dir),repo=repository(dir);
	if(!remotes.some(r=>r.remote===refName(remote,true)))throw new Error(tr('远端已变化','Remote changed'));
	const affected:string[]=[];
	for(const branch of branches)if(await git.getConfig({...repo,path:'branch.'+branch+'.remote'})===remote)affected.push(branch);
	return {remote,affected,config:digest(await fs.readFile(path.join(repo.gitdir,'config')))};
}

// Update the Git config as one unit, even when several branches track this remote.
export async function removeRemote(dir:string,plan:Awaited<ReturnType<typeof remoteRemoval>>){
	const fresh=await remoteRemoval(dir,plan.remote);
	if(JSON.stringify(fresh)!==JSON.stringify(plan))throw new Error(tr('远端配置已变化','Remote configuration changed'));
	await updateConfig(dir,plan.config,async temp=>{
		await git.deleteRemote({...temp,remote:plan.remote});
		for(const branch of plan.affected)for(const key of ['merge','remote'])await git.setConfig({...temp,path:'branch.'+branch+'.'+key,value:undefined});
	});
}

export async function serverBranches(dir:string,target:RemoteTarget,credentials?:Credentials){
	const {target:active}=await remoteState(dir);
	if(!active || JSON.stringify(active)!==JSON.stringify(target))throw new Error(tr('远端已变化','Remote changed'));
	const url=endpoint(target.url);
	const refs=await git.listServerRefs({url,http:transport(url),prefix:'refs/heads/',protocolVersion:1,onAuth:()=>credentials});
	return refs.filter(r=>r.ref.startsWith('refs/heads/')).map(r=>({name:refName(r.ref.slice(11)),oid:r.oid}));
}
export async function trackBranch(dir:string,target:RemoteTarget,selected:{name:string;oid:string},localName:string,credentials?:Credentials){
	const state=await remoteState(dir),repo=repository(dir);
	refName(localName);refName(selected.name);
	if(state.branches.includes(localName) || !state.target || JSON.stringify(state.target)!==JSON.stringify(target))throw new Error(tr('分支名称冲突或远端发生变化','Local branch exists or remote changed'));
	const fetchRules=await git.getConfigAll({...repo,path:'remote.'+target.remote+'.fetch'});
	if(fetchRules.length!==1 || fetchRules[0]!=='+refs/heads/*:refs/remotes/'+target.remote+'/*')throw new Error(fromEnglish('Custom fetch refspec requires manual review','自定义获取引用映射需要人工核对'));
	const result=await git.fetch({...repo,url:target.url,http:transport(target.url),remote:target.remote,ref:selected.name,
		remoteRef:selected.name,singleBranch:true,tags:false,onAuth:()=>credentials});
	if(result.fetchHead!==selected.oid)throw new Error(tr('远端分支已推进，请重新预览','Remote branch advanced. Preview again.'));
	await git.branch({...repo,ref:localName,object:selected.oid});
	await updateConfig(dir,state.config,async temp=>{
		await git.setConfig({...temp,path:'branch.'+localName+'.remote',value:target.remote});
		await git.setConfig({...temp,path:'branch.'+localName+'.merge',value:'refs/heads/'+selected.name});
	});
}
