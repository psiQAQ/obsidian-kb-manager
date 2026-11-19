import {fromEnglish} from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import { assertPrivateManifestHistory } from './manifest-privacy.ts';
import {previewVersion} from './versions.ts';
import {checkedNative,gitResult} from './network-native.ts';
import {endpoint,address,isSsh} from './network-http.ts';
import {digest,statIfPresent} from '../fs/vault.ts';
import {updateConfig} from './network-config.ts';
import {checkedIdentityArgs} from './identity.ts';

export type AuthMode='system'|'fallback';
export type SyncMethod='ff-only'|'merge'|'rebase';
export interface AutomationGrant {
	location:string; branch:string; remote:string; routeDigest:string; remoteBranch:string;
	commit:number; pull:number; push:number; paused?:'review'|'failed';
	autoGlobs:string; autoGlobMode:'exclude'|'include'; autoAfterEdits:boolean; autoFromLastCommit:boolean; autoPullOnStart:boolean;
}
export interface RemoteTarget {remote:string;url:string;pushUrl:string;remoteBranch:string;fetchDisplay:string;pushDisplay:string;signature:string}
export interface Credentials {username:string;password:string}

export function secretKey(id:string,url:string){
	return 'kb-manager-'+id+'-'+createHash('sha256').update(endpoint(url)).digest('hex').slice(0,24);
}

export function refName(name:string,remote=false){
	if(!name || !/^[\p{L}\p{N}_][\p{L}\p{N}_./-]*$/u.test(name) || name==='HEAD' ||
		name.includes('..') || (remote && name.includes('/')) ||
		name.split('/').some(s=>!s || s.startsWith('.') || s.endsWith('.') || s.endsWith('.lock')))throw new Error(fromEnglish('Invalid Git reference: ','无效的 Git 引用：')+name);
	return name;
}

export async function resolveRef(dir:string,ref:string){return (await gitResult(dir,['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).stdout.toString().trim();}
export async function ancestor(dir:string,older:string,newer:string){return (await gitResult(dir,['merge-base','--is-ancestor',older,newer],{allowedExitCodes:[0,1]})).code===0;}
export async function localConfig(dir:string){
 const items=(await gitResult(dir,['config','--local','--null','--list'])).stdout.toString().split('\0').filter(Boolean);
 return items.map(row=>{const i=row.indexOf('\n');return [row.slice(0,i),row.slice(i+1)] as const;});
}
export async function remoteState(dir:string) {
 const preview=await previewVersion(dir),branch=refName(preview.branch);
 const configFile=path.join(dir,'.git','config'),config=digest(await fs.readFile(configFile));
 const fields=await localConfig(dir);
 const get=(key:string)=>fields.filter(([k])=>k===key).map(([,value])=>value);
 const names=(await gitResult(dir,['remote'])).stdout.toString().trim().split(/\r?\n/u).filter(Boolean);
 const remotes=names.map(remote=>({remote,url:get('remote.'+remote+'.url')[0]??''}));
 const branches=(await gitResult(dir,['for-each-ref','--format=%(refname:strip=2)','refs/heads/'])).stdout.toString().trim().split(/\r?\n/u).filter(Boolean);
 const name=get('branch.'+branch+'.remote')[0]??'origin',merge=get('branch.'+branch+'.merge')[0];
 let target:RemoteTarget|undefined;
 const remote=remotes.find(r=>r.remote===name);
 if(remote && (!merge || merge.startsWith('refs/heads/'))){
  const fetch=await address(dir,remote.url,name),push=await address(dir,get('remote.'+name+'.pushurl')[0]??remote.url,name,true);
  target={remote:refName(name,true),url:fetch.url,pushUrl:push.url,remoteBranch:refName(merge?.slice(11)??branch),
   fetchDisplay:fetch.display,pushDisplay:push.display,signature:digest(JSON.stringify([fetch.signature,push.signature]))};
 }
 if(digest(await fs.readFile(configFile))!==config)throw new Error(fromEnglish('Repository configuration changed','仓库配置已变化'));
 return {preview,branches,remotes,target,config};
}
export async function bindingPlan(dir:string,branch:string,remote:string,url:string,remoteBranch:string){
	refName(remote,true);refName(remoteBranch);
	const state=await remoteState(dir);
	if(state.preview.branch!==branch)throw new Error(fromEnglish('Branch changed','分支已变化'));
	const fields=await localConfig(dir);
	const one=(key:string)=>{
		const matches=fields.filter(([name])=>name===key);
		if(matches.length>1)throw new Error(fromEnglish('Multiple values require manual review','此配置含多个值，请手动核对'));
		return matches[0]?.[1];
	};
	const old=one('remote.'+remote+'.url'),pushUrl=one('remote.'+remote+'.pushurl');
	if(old===undefined && state.remotes.some(r=>r.remote===remote))throw new Error(fromEnglish('Only a repository-local remote can be edited','只可编辑库内配置的远端'));
	const existing=old===undefined?undefined:await address(dir,old,remote);
	const oldPush=old===undefined?undefined:await address(dir,pushUrl??old,remote,true);
	const fetch=await address(dir,endpoint(url));
	const push=pushUrl===undefined?await address(dir,fetch.url,undefined,true):oldPush;
	return {branch,remote,remoteBranch,config:state.config,old:existing,oldPush,fetch,push,
		oldUpstream:one('branch.'+branch+'.remote'),oldBranch:one('branch.'+branch+'.merge')};
}
export async function bindRemote(dir:string,branch:string,remote:string,url:string,remoteBranch:string,reviewed?:Awaited<ReturnType<typeof bindingPlan>>) {
	const plan=await bindingPlan(dir,branch,remote,url,remoteBranch);
	if(reviewed?JSON.stringify(reviewed)!==JSON.stringify(plan):plan.old && plan.old.url!==plan.fetch.url)
		throw new Error(fromEnglish('Preview the remote configuration changes again','请重新预览远端配置修改'));
	await updateConfig(dir,plan.config,async tmp=>{
		const put=(key:string,value:string)=>gitResult(dir,['config','--file',path.join(tmp.gitdir,'config'),key,value]);
		await put('remote.'+remote+'.url',plan.fetch.url);
		if(!plan.old)await put('remote.'+remote+'.fetch','+refs/heads/*:refs/remotes/'+remote+'/*');
		await put('branch.'+branch+'.remote',remote);
		await put('branch.'+branch+'.merge','refs/heads/'+remoteBranch);
	});
}
export function authOptions(url:string,credentials?:Credentials){
 if(credentials && isSsh(url))throw new Error(fromEnglish('SSH uses system authentication.','SSH 使用系统认证。'));
 return {network:{url,basic:credentials?Buffer.from(credentials.username+':'+credentials.password).toString('base64'):undefined}};
}
export async function transfer(dir:string,operation:'fetch'|'push',target:RemoteTarget,credentials?:Credentials){
 const {preview,target:current}=await remoteState(dir);
 if(!current || JSON.stringify(current)!==JSON.stringify(target))throw new Error(fromEnglish('Remote target changed','远端目标已变化'));
 if(operation==='push'&&!preview.head)throw new Error(fromEnglish('There are no commits to push','尚无可推送的提交'));
 const remoteRef='refs/heads/'+target.remoteBranch,tracking='refs/remotes/'+target.remote+'/'+target.remoteBranch;
 if(operation==='push')await assertPrivateManifestHistory(dir,preview.head);
 const url=operation==='push'?target.pushUrl:target.url;
 if(operation==='push')await gitResult(dir,['push','--no-verify','--no-follow-tags','--recurse-submodules=no','--porcelain','--',target.remote,preview.head+':'+remoteRef],authOptions(url,credentials));
 else await gitResult(dir,['fetch','--refmap=','--no-tags','--no-recurse-submodules','--',target.remote,remoteRef+':'+tracking],authOptions(url,credentials));
}
export async function tree(dir:string,oid:string){
 if(!/^[a-f0-9]{40,64}$/u.test(oid))throw new Error('Invalid object ID');
 const data=(await gitResult(dir,['ls-tree','-rtz',oid])).stdout;
 const files=new Map<string,string>(),seen=new Set<string>();
 const text=new TextDecoder('utf-8',{fatal:true}).decode(data);
 for(const row of text.split('\0').filter(Boolean)){
  const hit=/^(040000 tree|100644 blob|100755 blob) ([a-f0-9]+)\t([\s\S]+)$/u.exec(row);
  if(!hit)throw new Error(fromEnglish('Unsupported target tree entry','目标树包含不支持的条目'));
  const file=hit[3]!,parts=file.split('/');
  if(parts.some(name=>!name || Array.from(name).some(c=>c.charCodeAt(0)<32) || /[<>:"\\|?*]/u.test(name) || /[. ]$/u.test(name) ||
   /^(?:\.git(?:attributes|modules)?|git~\d+|\.\.?|(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?)$/iu.test(name)))throw new Error(fromEnglish('Unsupported target tree path','目标树包含不支持的路径'));
  const key=file.normalize('NFC').toLowerCase();if(seen.has(key))throw new Error(fromEnglish('Path collision','路径冲突'));seen.add(key);
  if(!hit[1]!.startsWith('040000'))files.set(file,hit[2]+':'+hit[1]!.slice(0,6));
 }
 return files;
}
export async function changePlan(dir:string,ref:string){
	const preview=await previewVersion(dir);
	if(preview.changes.length || !preview.head)throw new Error(fromEnglish('Commit or store all changes before switching or pulling.','切换或拉取前请先提交或妥善保存所有变更。'));
	const oid=await resolveRef(dir,ref);
	const [before,after]=await Promise.all([tree(dir,preview.head),tree(dir,oid)]);
	if(['kb.toml','kb-manager.json'].some(name=>before.get(name)!==after.get(name)))throw new Error(fromEnglish('Incoming history changes the knowledge base identity. Review externally.','目标历史会修改知识库身份，请在外部核对。'));
	const changes=[...new Set([...before.keys(),...after.keys()])].filter(f=>before.get(f)!==after.get(f));
	for(const file of before.keys())if(((await statIfPresent(path.join(dir,file)))?.nlink??1)>1)throw new Error(fromEnglish('Working tree contains a hard link: ','工作区含硬链接：')+file);
	for(const file of changes)if(!before.has(file)){
		try {await fs.lstat(path.join(dir,file));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
		throw new Error(fromEnglish('Incoming path already exists: ','目标路径已存在：')+file);
	}
	return {ref,oid,head:preview.head,branch:preview.branch,changes,identity:preview.identity};
}

export async function applyChange(dir:string,plan:Awaited<ReturnType<typeof changePlan>>,operation:'switch'|'pull',method:SyncMethod,strategy:'none'|'ours'|'theirs'='none'){
	const fresh=await changePlan(dir,plan.ref);
	if(JSON.stringify(fresh)!==JSON.stringify(plan))throw new Error(fromEnglish('Repository changed. Preview again.','仓库已变化，请重新预览。'));

	if(operation==='switch'){
		if(!plan.ref.startsWith('refs/heads/'))throw new Error(fromEnglish('Choose a local branch','请选择本地分支'));
		const branch=refName(plan.ref.slice(11));
		await (await checkedNative(dir))(['switch','--no-recurse-submodules',branch]);
		return;
	}
	if(plan.oid===plan.head || await ancestor(dir,plan.oid,plan.head))return;
	const run=await checkedNative(dir);
	const needsIdentity=method!=='ff-only' && !await ancestor(dir,plan.head,plan.oid);
	const overrides=needsIdentity?await checkedIdentityArgs(dir,fresh.identity):[];
	if(method==='rebase')await run([...overrides,'rebase','--no-autostash',plan.oid]);
	else await run([...overrides,'merge','--no-edit',method==='ff-only'?'--ff-only':'--ff',
		...(method==='merge' && strategy!=='none'?['-X',strategy]:[]),plan.oid]);
}

export async function createBranch(dir:string,name:string){
	if(!(await remoteState(dir)).preview.head)throw new Error(fromEnglish('Create a first commit before branching','请先创建首个提交，再创建分支'));
	await gitResult(dir,['branch','--',refName(name),'HEAD']);
}
