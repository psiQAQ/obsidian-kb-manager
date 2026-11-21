import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {remoteState,refName,resolveRef,ancestor,localConfig,authOptions} from './network.ts';
import type {Credentials,RemoteTarget} from './network.ts';
import {tr} from '../i18n.ts';
import {updateConfig} from './network-config.ts';
import {gitResult} from './network-native.ts';

export async function deletionPlan(dir:string,branch:string){
 const {preview,config}=await remoteState(dir);
 refName(branch);
 if(preview.branch===branch)throw new Error(tr('当前分支无法删除','Cannot delete the current branch'));
 const tip=await resolveRef(dir,'refs/heads/'+branch);
 if(!await ancestor(dir,tip,preview.head))throw new Error(tr('分支还未合入当前分支','Branch is not merged into the current branch'));
 return {branch,tip,current:preview.branch,head:preview.head,config};
}
export async function removeBranch(dir:string,plan:Awaited<ReturnType<typeof deletionPlan>>){
 const fresh=await deletionPlan(dir,plan.branch);
 if(JSON.stringify(plan)!==JSON.stringify(fresh))throw new Error(tr('分支已变化','Branch changed'));
 const gd=path.join(dir,'.git'),current='refs/heads/'+plan.current;
 const locks=new Map<string,fs.FileHandle>();
 try{
  for(const name of ['HEAD',current]){
   const file=path.join(gd,name+'.lock');await fs.mkdir(path.dirname(file),{recursive:true});locks.set(file,await fs.open(file,'wx'));
  }
  if((await gitResult(dir,['symbolic-ref','HEAD'])).stdout.toString().trim()!==current || await resolveRef(dir,current)!==plan.head)
   throw new Error(tr('当前分支已变化','Current branch changed'));
  await gitResult(dir,['update-ref','-d','refs/heads/'+plan.branch,plan.tip]);
  const fields=await localConfig(dir);
  if(fields.some(([key])=>key.startsWith('branch.'+plan.branch+'.')))await updateConfig(dir,plan.config,async tmp=>{
   await gitResult(dir,['config','--file',path.join(tmp.gitdir,'config'),'--remove-section','branch.'+plan.branch]);
  });
 }finally{for(const [file,lock] of [...locks].reverse()){await lock.close();await fs.unlink(file);}}
}
export async function remoteRemoval(dir:string,remote:string){
 const {remotes,branches,config}=await remoteState(dir),fields=await localConfig(dir);
 if(!remotes.some(r=>r.remote===refName(remote,true)))throw new Error(tr('远端已变化','Remote changed'));
 const affected=branches.filter(branch=>fields.some(([k,v])=>k==='branch.'+branch+'.remote' && v===remote));
 return {remote,affected,config};
}
export async function removeRemote(dir:string,plan:Awaited<ReturnType<typeof remoteRemoval>>){
 const fresh=await remoteRemoval(dir,plan.remote);
 if(JSON.stringify(fresh)!==JSON.stringify(plan))throw new Error(tr('远端配置已变化','Remote configuration changed'));
 await updateConfig(dir,plan.config,async tmp=>{
  const prefix=['config','--file',path.join(tmp.gitdir,'config')];
  await gitResult(dir,[...prefix,'--remove-section','remote.'+plan.remote]);
  for(const branch of plan.affected)for(const key of ['merge','remote'])await gitResult(dir,[...prefix,'--unset-all','branch.'+branch+'.'+key],{allowedExitCodes:[0,5]});
 });
}

async function verifyTarget(dir:string,target:RemoteTarget){
 const {target:active}=await remoteState(dir);
 if(!active || JSON.stringify(active)!==JSON.stringify(target))throw new Error(tr('远端已变化','Remote changed'));
}
export async function serverBranches(dir:string,target:RemoteTarget,credentials?:Credentials){
 await verifyTarget(dir,target);
 const result=await gitResult(dir,['ls-remote','--heads','--',target.remote],authOptions(target.url,credentials));
 return result.stdout.toString().trimEnd().split('\n').filter(Boolean).map(row=>{
  const parts=row.match(/^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/u);
  if(!parts?.[1] || !parts[2])throw new Error(tr('服务端分支信息无效','Invalid advertised branch'));
  return {name:refName(parts[2]),oid:parts[1]};
 });
}
export async function trackBranch(dir:string,target:RemoteTarget,selected:{name:string;oid:string},localName:string,credentials?:Credentials){
 const state=await remoteState(dir);
 refName(localName);refName(selected.name);
 if(state.branches.includes(localName) || JSON.stringify(state.target)!==JSON.stringify(target))throw new Error(tr('分支名称冲突或远端发生变化','Local branch exists or remote changed'));
 const tracking='refs/remotes/'+target.remote+'/'+selected.name,ref='refs/heads/'+selected.name;
 await gitResult(dir,['fetch','--refmap=','--no-tags','--no-recurse-submodules','--',target.remote,ref+':'+tracking],authOptions(target.url,credentials));
 if(await resolveRef(dir,tracking)!==selected.oid)throw new Error(tr('远端分支已推进，请重新预览','Remote branch advanced. Preview again.'));
 await gitResult(dir,['branch','--',localName,selected.oid]);
 await updateConfig(dir,state.config,async tmp=>{
  const prefix=['config','--file',path.join(tmp.gitdir,'config')];
  await gitResult(dir,[...prefix,'branch.'+localName+'.remote',target.remote]);
  await gitResult(dir,[...prefix,'branch.'+localName+'.merge',ref]);
 });
}
