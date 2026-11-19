import git from 'isomorphic-git';
import type {HttpClient,GitAuth} from 'isomorphic-git';
import {tr} from '../i18n.ts';
import {parseIdentity,identityFile} from '../kb/identity-core.ts';
import {readMapping} from '../kb/mapping.ts';
import {component,decode,hash,key,relative,ensureFolder} from './disk.ts';
import {branchName,changed,expectSnapshot,locked,mobileStatus,repo} from './git.ts';
import type {Store,Snapshot} from './git.ts';
import {destination,discoverMobile,scratch,publish} from './catalog.ts';
import type {Catalog} from './catalog.ts';

export function endpoint(raw:string){
	const url=new URL(raw);
	if(raw.trim()!==raw || /[\s\\?#]/u.test(raw) || url.protocol!=='https:' || url.username || url.password || url.pathname==='/' || url.search || url.hash)throw new Error(tr('请输入不含凭据的 HTTPS 地址','Enter an HTTPS URL without embedded credentials'));
	return url.href;
}
export async function secretKey(id:string,url:string){return 'kb-manager-'+id+'-'+(await hash(endpoint(url))).slice(0,24);}
export async function upstream(s:Store,branch:string){
	const r=repo(s);
	const remote=String(await git.getConfig({...r,path:'branch.'+branch+'.remote'})??'origin');
	branchName(remote);component(remote);
	const merge=String(await git.getConfig({...r,path:'branch.'+branch+'.merge'})??'refs/heads/'+branch);
	if(!merge.startsWith('refs/heads/'))throw changed();
	const list=await git.listRemotes(r),found=list.find(v=>v.remote===remote);
	if(!found)return undefined;
	const specs:unknown[]=await git.getConfigAll({...r,path:'remote.'+remote+'.fetch'});
	if(specs.length!==1 || specs[0]!=='+refs/heads/*:refs/remotes/'+remote+'/*')throw new Error(tr('不支持自定义远端 refspec','Custom remote refspecs are unsupported'));
	return {remote,url:endpoint(found.url),branch:branchName(merge.slice(11))};
}
export type Target=NonNullable<Awaited<ReturnType<typeof upstream>>>;
export async function transfer(s:Store,old:Snapshot,op:'fetch'|'push',target:Target,http:HttpClient,auth?:GitAuth){
	const branchLock='refs/heads/'+branchName(old.branch)+'.lock';
	await locked(s,['config.lock','HEAD.lock',branchLock],async owned=>{
		await expectSnapshot(s,old,owned);
		if(JSON.stringify(await upstream(s,old.branch))!==JSON.stringify(target))throw changed();
		const args={...repo(s),remote:target.remote,url:target.url,http,onAuth:()=>auth};
		if(op==='fetch')await git.fetch({...args,ref:target.branch,singleBranch:true,tags:false});
		else await git.push({...args,ref:old.branch,remoteRef:target.branch,force:false});
	});
}
export async function tree(s:Store,oid:string){
	const r=repo(s),files=new Map<string,string>(),names=new Set<string>();
	async function visit(prefix:string,ref:string){
		for(const item of (await git.readTree({...r,oid:ref})).tree){
			const file=prefix+component(item.path);
			relative(file,s.configDir);
			if(['.gitattributes','.gitmodules'].includes(key(item.path)) || !['040000','100644','100755'].includes(item.mode) || names.has(key(file)))
				throw new Error(tr('不支持的 Git 树路径或类型','Unsupported Git tree path or mode')+': '+file);
			names.add(key(file));
			if(item.type==='tree')await visit(file+'/',item.oid);else files.set(file,item.oid+':'+item.mode);
		}
	}
	await visit('',oid);
	return files;
}
export async function pullPlan(s:Store){
	const old=await mobileStatus(s);
	if(old.changes.length || !old.head)throw new Error(tr('请先保存本库所有更改','Commit or store all changes first'));
	const target=await upstream(s,old.branch);if(!target)throw new Error(tr('未设置上游','No upstream configured'));
	const r=repo(s),oid=await git.resolveRef({...r,ref:'refs/remotes/'+target.remote+'/'+target.branch});
	if(oid!==old.head && !await git.isDescendent({...r,oid,ancestor:old.head}))throw new Error(tr('无法快进，请在桌面处理分叉','Cannot fast-forward. Review diverged branches on desktop.'));
	const previous=await tree(s,old.head),incoming=await tree(s,oid);
	if(!previous.has(identityFile) || previous.get(identityFile)!==incoming.get(identityFile))throw new Error(tr('传入历史会更改知识库身份','Incoming history changes the library identity'));
	const changes=[...new Set([...previous.keys(),...incoming.keys()])].filter(p=>previous.get(p)!==incoming.get(p)).sort();
	for(const file of changes){
		const before=previous.get(file),path=s.root+'/'+file,st=await s.disk.stat(path);
		if(!before){if(st)throw changed();continue;}
		// A mobile provider may preserve timestamps or round them. Verify the
		// actual bytes before authorizing checkout to replace a tracked file.
		if(st?.type!=='file' || (await git.hashBlob({object:new Uint8Array(await s.disk.readBinary(path))})).oid!==before.slice(0,40))throw changed();
	}
	return {old,target,oid,changes};
}
export async function applyPull(s:Store,plan:Awaited<ReturnType<typeof pullPlan>>){
	const fresh=await pullPlan(s);
	if(fresh.old.signature!==plan.old.signature || fresh.oid!==plan.oid)throw changed();
	if(plan.oid===plan.old.head)return;
	const ref='refs/heads/'+fresh.old.branch;
	await ensureFolder(s.disk,s.root+'/.git/'+ref.slice(0,ref.lastIndexOf('/')));
	await locked(s,['HEAD.lock','index.lock',ref+'.lock'],async locks=>{
		await expectSnapshot(s,plan.old,locks);
		await git.checkout({...repo(s),ref:plan.oid,noUpdateHead:true});
		await git.writeRef({...repo(s),ref,value:plan.oid,force:true});
	});
}
export async function download(ctx:Catalog,parent:string,name:string,url:string,http:HttpClient,auth?:GitAuth){
	const location=await destination(ctx,parent,name),temp=await scratch(ctx,parent);
	const s={disk:ctx.disk,root:temp,configDir:ctx.configDir},r=repo(s);
	let disposed=false;
	const cleanup=async()=>{if(!disposed){await ctx.disk.rmdir(temp,true);disposed=true;}};
	try{
		await git.clone({...r,url:endpoint(url),http,noCheckout:true,singleBranch:true,noTags:true,onAuth:()=>auth});
		const head=await git.resolveRef({...r,ref:'HEAD'}), files=await tree(s,head);
		const branch=branchName((await git.currentBranch(r))??'');
		const read=async(file:string)=>decode((await git.readBlob({...r,oid:head,filepath:file})).blob);
		if(!files.has(identityFile) && !files.has('kb.toml'))throw new Error(tr('远端不是知识库','Remote is not a knowledge base'));
		const identity=files.has(identityFile)?parseIdentity(await read(identityFile)):undefined;
		if(files.has('kb.toml'))readMapping(await read('kb.toml'));
		return {location,head,files:[...files.keys()],branch,cleanup,publish:async(current:Catalog)=>{
			await destination(current,parent,name);
			if(identity && (await discoverMobile(current)).some(l=>l.identity?.id===identity.id))throw new Error(tr('已有相同身份的知识库','Library ID already exists'));
			if(disposed || await git.resolveRef({...r,ref:branch})!==head)throw changed();
			await git.checkout({...r,ref:branch});
			await publish(current,temp,parent,name);await cleanup();
		}};
	}catch(error){await cleanup();throw error;}
}
