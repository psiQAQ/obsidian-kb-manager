import git from 'isomorphic-git';
import type {HttpClient,GitAuth} from 'isomorphic-git';
import {tr} from '../i18n.ts';
import {readManifest,identityFile,withManifestIgnore,writeIdentity} from '../kb/identity-core.ts';
import {checkSpelling,component,decode,hash,key,relative,ensureFolder,replaceText} from './disk.ts';
import {branchName,changed,containsPrivateManifest,expectSnapshot,locked,mobileStatus,portableManifestError,repo} from './git.ts';
import type {Store,Snapshot} from './git.ts';
import {destination,discoverMobile,newIdentity,scratch,publish} from './catalog.ts';
import type {Catalog} from './catalog.ts';
import {applyMobileRegistryIgnore,previewMobileRegistryIgnore,readMobileRegistry,updateMobileRegistry} from './registration.ts';
import {applyCloneBindings,previewBindings} from './bindings.ts';
import type {BindingPreview} from './bindings.ts';
import {endpoint} from './http.ts';

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
async function verifyPortableHistory(s:Store,head:string){
	const r=repo(s),pending=[head],commits=new Set<string>(),trees=new Set<string>();
	while(pending.length){
		const oid=pending.pop()!;
		if(!oid || commits.has(oid))continue;
		commits.add(oid);
		const {commit}=await git.readCommit({...r,oid});
		pending.push(...commit.parent);
		if(trees.has(commit.tree))continue;
		trees.add(commit.tree);
		let data:Uint8Array|undefined;
		try{data=(await git.readBlob({...r,oid,filepath:identityFile})).blob;}
		catch(e){if(!(e instanceof git.Errors.NotFoundError))throw e;}
		if(data && containsPrivateManifest(decode(data)))throw portableManifestError();
	}
}
export async function transfer(s:Store,old:Snapshot,op:'fetch'|'push',target:Target,http:HttpClient,auth?:GitAuth){
	const branchLock='refs/heads/'+branchName(old.branch)+'.lock';
	await locked(s,['config.lock','HEAD.lock',branchLock],async owned=>{
		await expectSnapshot(s,old,owned);
		if(JSON.stringify(await upstream(s,old.branch))!==JSON.stringify(target))throw changed();
		const args={...repo(s),remote:target.remote,url:target.url,http,onAuth:()=>auth};
		if(op==='fetch')await git.fetch({...args,ref:target.branch,singleBranch:true,tags:false});
		else{
			await verifyPortableHistory(s,old.head);
			await git.push({...args,ref:old.branch,remoteRef:target.branch,force:false});
		}
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
	if(previous.get(identityFile)!==incoming.get(identityFile))throw new Error(tr('传入历史会更改知识库清单','Incoming history changes the library manifest'));
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
export type CloneChoice={mode:'embedded'}|{mode:'original';raw:string}|{mode:'new'};
export interface CloneReview {
	choice:CloneChoice; source:string; bindings:BindingPreview; ignore?:string; nextIgnore:string;
	registryIgnore:Awaited<ReturnType<typeof previewMobileRegistryIgnore>>;
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
		const remoteManifest=files.has(identityFile)?await read(identityFile):undefined,manifest=remoteManifest??'';
		const embedded=remoteManifest===undefined?undefined:readManifest(manifest);
		if([...files.keys()].some(file=>key(file.split('/')[0]!)===identityFile && file!==identityFile))
			throw new Error(tr('远端文件与 kb.toml 的路径冲突','A remote path conflicts with kb.toml'));
		await git.checkout({...r,ref:branch});
		const excludePath=temp+'/.git/info/exclude';
		const ignore=await ctx.disk.stat(excludePath)?await ctx.disk.read(excludePath):undefined;
		async function review(current:Catalog,choice:CloneChoice,skeleton:Record<string,string>,approved?:CloneReview):Promise<CloneReview>{
			await destination(current,parent,name);
			if(disposed || await git.resolveRef({...r,ref:branch})!==head)throw changed();
			if(embedded?.identity && choice.mode!=='embedded')throw new Error(tr('请使用远端已有的知识库清单','Use the existing manifest from the remote'));
			let source=choice.mode==='original'?choice.raw:manifest;
			if(choice.mode==='new'){
				const identity=newIdentity(name,'',undefined,embedded?.mapping?.index);
				if(approved)identity.id=approved.bindings.id;
				source=writeIdentity(manifest,identity);
			}else if(!source || !readManifest(source).identity){
				throw new Error(tr('所选清单缺少原知识库 ID','The selected manifest has no original library ID'));
			}
			const bindings=await previewBindings(current,location,temp,source,skeleton);
			const nextIgnore=withManifestIgnore(ignore??'');
			return {choice,source,bindings,ignore,nextIgnore,registryIgnore:await previewMobileRegistryIgnore(current)};
		}
		return {location,head,files:[...files.keys()],branch,tracked:remoteManifest!==undefined,hasManifest:!!embedded?.identity,cleanup,review,publish:async(current:Catalog,approved:CloneReview,skeleton:Record<string,string>)=>{
			const fresh=await review(current,approved.choice,skeleton,approved);
			if(JSON.stringify(fresh)!==JSON.stringify(approved))throw changed();
			await readMobileRegistry(current);
			if((await discoverMobile(current)).some(l=>l.identity?.id===fresh.bindings.id))throw new Error(tr('已有相同身份的知识库','Library ID already exists'));
			const merged=await applyCloneBindings(current,temp,fresh.bindings);
			const manifestPath=temp+'/'+identityFile;
			await checkSpelling(current.disk,manifestPath);
			await replaceText(current.disk,manifestPath,remoteManifest,merged);
			await ensureFolder(current.disk,temp+'/.git/info');
			await replaceText(current.disk,excludePath,ignore,fresh.nextIgnore);
			if(remoteManifest===undefined && !await git.isIgnored({...r,filepath:identityFile}))
				throw new Error(tr('远端忽略规则使 kb.toml 无法忽略，请检查 .gitignore','Remote ignore rules expose kb.toml. Review .gitignore'));
			await applyMobileRegistryIgnore(current,fresh.registryIgnore);
			await publish(current,temp,parent,name);
			try{await updateMobileRegistry(current,{add:[location]});}
			catch(error){throw new Error(String(error)+tr('。目录已导入，可通过扫描登记：','. The folder was imported and can be registered from a scan: ')+location);}
			await cleanup();
		}};
	}catch(error){await cleanup();throw error;}
}
