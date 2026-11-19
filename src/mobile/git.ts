import git from 'isomorphic-git';
import {parse} from 'smol-toml';
import {tr} from '../i18n.ts';
import {identityFile} from '../kb/identity-core.ts';
import {bytes,buffer,children,decode,ensureFolder,hash,key,mobileRepo,relative} from './disk.ts';
import type {Disk} from './disk.ts';

export interface Store {disk:Disk;root:string;configDir:string}
export interface Author {name:string;email:string}
export const repo=(s:Store)=>mobileRepo(s.disk,s.root,s.configDir);
export function ignoredParents(r:ReturnType<typeof repo>){
	const ignored=new Map<string,Promise<boolean>>();
	return async (file:string)=>{
		// A nested negation cannot re-include a file inside an ignored directory.
		for(let slash=file.indexOf('/');slash!==-1;slash=file.indexOf('/',slash+1)){
			const folder=file.slice(0,slash+1);
			let check=ignored.get(folder);
			if(!check){check=git.isIgnored({...r,filepath:folder});ignored.set(folder,check);}
			if(await check)return true;
		}
		return false;
	};
}
const meta=(s:Store,name:string)=>s.root+'/.git/'+name;
export const portableManifestError=()=>new Error(tr('Git 中含有本地 kb.toml 清单。请在桌面检查暂存区和提交历史。','Git contains the local kb.toml manifest. Review the index and commit history on desktop.'));
export function containsPrivateManifest(raw:string){
	const manifest=parse(raw.replace(/^\uFEFF/u,''));
	return manifest.manager!==undefined || manifest.preferences!==undefined;
}
export const changed=()=>new Error(tr('目标已变化，请重新预览','Target changed. Review the preview again.'));
export function branchName(name:string){
	if(!/^[\p{L}\p{N}_][\p{L}\p{N}._/-]*$/u.test(name) || name==='HEAD' || name.includes('..') ||
		name.split('/').some(p=>!p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock')))throw new Error(tr('分支名无效','Invalid branch name'));
	return name;
}
function validateIndex(raw:ArrayBuffer,configDir:string){
	const data=new Uint8Array(raw), view=new DataView(raw);
	const executables:string[]=[];
	if(data.length<32 || decode(data.subarray(0,4))!=='DIRC' || view.getUint32(4)!==2)throw new Error(tr('索引格式不受支持','Unsupported Git index format'));
	const count=view.getUint32(8);
	let offset=12;
	for(let i=0;i<count;i++){
		if(offset+62>=data.length-20 || (view.getUint16(offset+60)&0xf000) || ![0o100644,0o100755].includes(view.getUint32(offset+24)))
			throw new Error(tr('索引包含冲突或特殊条目','Conflicted or unsupported Git index'));
		const end=data.indexOf(0,offset+62);
		if(end<0 || end>=data.length-20)throw new Error(tr('索引路径损坏','Invalid index path'));
		const path=relative(decode(data.subarray(offset+62,end)),configDir);
		if(view.getUint32(offset+24)===0o100755)executables.push(path);
		offset+=Math.ceil((end-offset+1)/8)*8;
	}
	while(offset<data.length-20){
		if(decode(data.subarray(offset,offset+4))!=='TREE')throw new Error(tr('索引扩展不受支持','Unsupported Git index extension'));
		offset+=8+view.getUint32(offset+4);
	}
	if(offset!==data.length-20)throw new Error(tr('索引长度无效','Invalid index size'));
	return executables;
}
async function checkWorktree(s:Store,dir=s.root):Promise<void>{
	const entries=await children(s.disk,dir);
	for(const path of [...entries.files,...entries.folders]){
		const file=path.slice(s.root.length+1);
		if(file==='.git')continue;
		relative(file,s.configDir);
		if(['.gitmodules','.gitattributes'].includes(key(path.slice(dir.length+1))))throw new Error(tr('此库使用移动版不支持的 Git 工作区配置','Unsupported Git worktree configuration on mobile')+': '+file);
	}
	for(const folder of entries.folders)if(folder!==s.root+'/.git')await checkWorktree(s,folder);
}
export async function guard(s:Store,owned:ReadonlySet<string>=new Set()){
	if((await s.disk.stat(s.root+'/.git'))?.type!=='folder')throw new Error(tr('需要独立的 .git 文件夹','A standalone .git folder is required'));
	const head=(await s.disk.read(meta(s,'HEAD'))).trim();
	if(!head.startsWith('ref: refs/heads/'))throw new Error(tr('需要本地分支','A local branch is required'));
	const branch=branchName(head.slice(16));
	for(const name of ['HEAD.lock','index.lock','config.lock','refs/heads/'+branch+'.lock','MERGE_HEAD','rebase-merge','rebase-apply','CHERRY_PICK_HEAD','REVERT_HEAD','sequencer','gitdir','commondir','worktrees','objects/info/alternates','config.worktree','info/attributes']){
		if(!owned.has(name) && await s.disk.stat(meta(s,name)))throw new Error(tr('仓库状态不支持此操作','Repository state prevents this operation')+': '+name);
	}
	const config=await s.disk.read(meta(s,'config'));
	if(/^\s*\[\s*(?:include|includeif|extensions|filter)\b|^\s*(?:worktree|attributesfile|sparsecheckout|bare\s*=\s*true|autocrlf\s*=\s*(?:true|input))\b/imu.test(config))
		throw new Error(tr('此库使用特殊 Git 配置','This repository uses unsupported Git configuration'));
	const idx=meta(s,'index'),raw=await s.disk.stat(idx)?await s.disk.readBinary(idx):undefined;
	const executables=raw?validateIndex(raw,s.configDir):[];
	return {branch,config:await hash(config),index:raw?await hash(new Uint8Array(raw)):'',executables};
}

export async function mobileStatus(s:Store,owned?:ReadonlySet<string>){
	const state=await guard(s,owned), r=repo(s);
	const ignoredParent=ignoredParents(r);
	await checkWorktree(s);
	let head='';
	try{head=await git.resolveRef({...r,ref:'HEAD'});}catch(e){if(!(e instanceof git.Errors.NotFoundError))throw e;}
	const changes=[];
	for(const [file,h,w,i] of await git.statusMatrix({...r,refresh:false})){
		relative(file,s.configDir);
		if(h===w && h===i)continue;
		if(!h && w && !i && await ignoredParent(file))continue;
		const fingerprint=w?await hash(new Uint8Array(await s.disk.readBinary(s.root+'/'+file))):undefined;
		changes.push({file,h,w,i,fingerprint});
	}
	return {...state,head,changes,signature:await hash(JSON.stringify([state,head,changes]))};
}
export type Snapshot=Awaited<ReturnType<typeof mobileStatus>>;
export async function expectSnapshot(s:Store,old:Snapshot,owned?:ReadonlySet<string>){
	if((await mobileStatus(s,owned)).signature!==old.signature)throw changed();
}

// copy() is the DataAdapter operation with documented fail-if-present semantics.
export async function locked<T>(s:Store,names:string[],action:(owned:Set<string>)=>Promise<T>){
	const token=crypto.randomUUID(),tmp=meta(s,'kb-owner-'+token),owned=new Set<string>();
	await s.disk.write(tmp,token);
	try{
		for(const name of names){await s.disk.copy(tmp,meta(s,name));owned.add(name);}
		return await action(owned);
	}finally{
		try{for(const name of owned){const file=meta(s,name);if(await s.disk.read(file)===token)await s.disk.remove(file);}}
		finally{await s.disk.remove(tmp);}
	}
}
export function effectiveAuthor(local:Author,device:Author):Author{
	const name=local.name.trim() || device.name.trim(),email=local.email.trim() || device.email.trim();
	if(!name || !email || [name,email].some(s=>/[<>]/u.test(s)||Array.from(s).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127)))
		throw new Error(tr('请在本库或本设备的 Vault 设置中填写有效的作者和邮箱','Set a valid author and email for this library or this vault on this device.'));
	return {name,email};
}
export async function localAuthor(s:Store):Promise<Author>{
	const r=repo(s);
	const field=async(key:string)=>{
		const values=await git.getConfigAll({...r,path:'user.'+key}) as unknown[];
		if(values.length>1 || values.some(v=>typeof v!=='string'))throw new Error(tr('作者身份配置有重复值','Duplicate author identity values'));
		return typeof values[0]==='string'?values[0]:'';
	};
	return {name:await field('name'), email:await field('email')};
}
export async function configure(s:Store,snapshot:Snapshot,updates:Record<string,string|undefined>){
	await locked(s,['config.lock'],async locks=>{
		await expectSnapshot(s,snapshot,locks);
		const r=repo(s),path=meta(s,'config'),initial=await s.disk.read(path);
		let text=initial;
		const promises={...r.fs.promises,readFile:async(file:string,opt?:string|{encoding?:string})=>
			file===r.gitdir+'/config'?text:r.fs.promises.readFile(file,opt),
			writeFile:async(file:string,value:string|Uint8Array)=>{
				if(file!==r.gitdir+'/config')throw changed();
				text=typeof value==='string'?value:decode(value);
			}};
		for(const [name,value] of Object.entries(updates)){
			if((await git.getConfigAll({...r,fs:{promises},path:name})).length>1)throw new Error(tr('配置项重复','Duplicate configuration entry')+': '+name);
			await git.setConfig({...r,fs:{promises},path:name,value});
		}
		if(await s.disk.read(path)!==initial)throw changed();
		await s.disk.write(path,text);
	});
}

export async function editIndex(s:Store,old:Snapshot,files:string[],stage:boolean){
	await locked(s,['index.lock'],async locks=>{
		await expectSnapshot(s,old,locks);
		const r=repo(s),dest=meta(s,'index');
		const orig=await s.disk.stat(dest)?new Uint8Array(await s.disk.readBinary(dest)):undefined;
		let next=orig;
		const index=r.gitdir+'/index',noEntry=()=>Object.assign(new Error('Missing index'),{code:'ENOENT'});
		const promises={...r.fs.promises,readFile:async(path:string,opt?:string|{encoding?:string})=>{
			if(path!==index)return r.fs.promises.readFile(path,opt);
			if(!next)throw noEntry();
			return next;
		},writeFile:async(path:string,value:string|Uint8Array)=>{
			if(path!==index)return r.fs.promises.writeFile(path,value);
			next=typeof value==='string'?bytes(value):new Uint8Array(value);
		},lstat:async(path:string)=>{
			if(path!==index)return r.fs.promises.lstat(path);
			if(!next)throw noEntry();
			return {...await r.fs.promises.stat(r.gitdir+'/HEAD'),size:next.length};
		}};
		const target={...r,fs:{promises}};
		for(const file of new Set(files)){
			const change=old.changes.find(c=>c.file===file && (stage?c.w!==c.i:c.i!==c.h));
			if(!change)throw changed();
			if(stage && change.w && key(file)===identityFile)throw portableManifestError();
			if(stage && change.w && old.executables.includes(file))
				throw new Error(tr('请在桌面暂存可执行文件以保留权限','Stage executable files on desktop to preserve their mode')+': '+file);
			if(stage && change.w)await git.add({...target,filepath:file});
			else if(stage || !old.head)await git.remove({...target,filepath:file});
			else await git.resetIndex({...target,filepath:file,ref:old.head});
		}
		await expectSnapshot(s,old,locks);
		if(next)await s.disk.writeBinary(dest,buffer(next));
	});
}
export async function commit(s:Store,old:Snapshot,message:string,device:Author){
	if(!message.trim() || !old.changes.some(c=>c.h!==c.i))throw new Error(tr('请暂存变更并填写提交说明','Stage changes and enter a commit message'));
	const ref='refs/heads/'+old.branch;
	// The branch directory can be absent before the first commit.
	await ensureFolder(s.disk,meta(s,ref.slice(0,ref.lastIndexOf('/'))));
	await locked(s,['index.lock','HEAD.lock',ref+'.lock'],async locks=>{
		await expectSnapshot(s,old,locks);
		const r=repo(s);
		if((await git.listFiles(r)).includes(identityFile)){
			await git.walk({...r,trees:[git.STAGE()],map:async(path,[entry])=>{
				if(path==='.')return undefined;
				if(path===identityFile && entry){
					const {blob}=await git.readBlob({...r,oid:await entry.oid()});
					if(containsPrivateManifest(decode(blob)))throw portableManifestError();
				}
				return null;
			}});
		}
		const author=effectiveAuthor(await localAuthor(s),device);
		await git.commit({...r,author,message:message.trim(),disallowEmpty:true});
	});
}
export async function mobileHistory(s:Store,cursor?:string){
	await guard(s);
	if(cursor && !/^[a-f0-9]{40}$/u.test(cursor))throw changed();
	try{const entries=await git.log({...repo(s),ref:cursor??'HEAD',depth:21});return {entries:entries.slice(0,20),next:entries[20]?.oid};}
	catch(e){if(e instanceof git.Errors.NotFoundError && !cursor)return {entries:[],next:undefined};throw e;}
}
