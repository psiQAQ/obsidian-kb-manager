import {fromEnglish} from '../i18n.ts';
import git from 'isomorphic-git';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {repository} from './repository.ts';
import {previewVersion} from './versions.ts';
import {checkedNative} from './network-native.ts';
import {endpoint,transport} from './network-http.ts';
import {digest,statIfPresent} from '../fs/vault.ts';
import {updateConfig} from './network-config.ts';
import {requireIdentity} from './identity.ts';

export type Backend='builtin'|'native';
export type SyncMethod='ff-only'|'merge'|'rebase';
export interface AutomationGrant {
	location:string; branch:string; remote:string; url:string; remoteBranch:string;
	backend:Backend; commit:number; pull:number; push:number; paused?:string;
	autoGlobs:string; autoGlobMode:'exclude'|'include'; autoAfterEdits:boolean; autoFromLastCommit:boolean; autoPullOnStart:boolean;
}
export interface RemoteTarget {remote:string;url:string;remoteBranch:string}
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

export async function remoteState(dir:string) {
	const preview=await previewVersion(dir),repo=repository(dir);
	refName(preview.branch);
	const remotes=await git.listRemotes(repo),branches=await git.listBranches(repo);
	const currentRemote:unknown=await git.getConfig({...repo,path:'branch.'+preview.branch+'.remote'});
	const merge:unknown=await git.getConfig({...repo,path:'branch.'+preview.branch+'.merge'});
	const remote=remotes.find(r=>r.remote===(currentRemote??'origin'));
	let target:RemoteTarget|undefined;
	if(remote && (merge===undefined || typeof merge==='string' && merge.startsWith('refs/heads/'))){
		target={remote:refName(remote.remote,true),url:endpoint(remote.url),remoteBranch:refName(merge?.slice(11)??preview.branch)};
	}
	return {preview,branches,remotes,target,config:digest(await fs.readFile(path.join(repo.gitdir,'config')))};
}
export async function bindRemote(dir:string,branch:string,remote:string,url:string,remoteBranch:string) {
	const state=await remoteState(dir);
	if(state.preview.branch!==branch)throw new Error(fromEnglish('Branch changed','分支已变化'));
	refName(remote,true);refName(remoteBranch);
	const canonical=endpoint(url);
	const existing=state.remotes.find(r=>r.remote===remote);
	if(existing && endpoint(existing.url)!==canonical)throw new Error(fromEnglish('Remote already has a different URL. Choose a new name.','同名远端已绑定其他 URL，请选择新名称。'));
	await updateConfig(dir,state.config,async repo=>{
		if(!existing)await git.addRemote({...repo,remote,url:canonical});
		await git.setConfig({...repo,path:'branch.'+branch+'.remote',value:remote});
		await git.setConfig({...repo,path:'branch.'+branch+'.merge',value:'refs/heads/'+remoteBranch});
	});
}

export async function transfer(dir:string,operation:'fetch'|'push',target:RemoteTarget,backend:Backend,credentials?:Credentials){
	const {preview,target:current}=await remoteState(dir);
	if(!current || JSON.stringify(current)!==JSON.stringify(target))throw new Error(fromEnglish('Remote target changed','远端目标已变化'));
	if(operation==='push'&&!preview.head)throw new Error(fromEnglish('There are no commits to push','尚无可推送的提交'));
	const repo=repository(dir);
	const fetchRules=await git.getConfigAll({...repo,path:'remote.'+target.remote+'.fetch'});
	if(fetchRules.length!==1 || fetchRules[0]!=='+refs/heads/*:refs/remotes/'+target.remote+'/*')throw new Error(fromEnglish('Custom fetch refspec requires manual review','自定义获取引用映射需要人工核对'));
	if((await git.getConfigAll({...repo,path:'remote.'+target.remote+'.pushurl'})).length)throw new Error(fromEnglish('Separate push URL requires manual review','请核对单独配置的推送 URL'));
	const remoteRef='refs/heads/'+target.remoteBranch;
	const tracking='refs/remotes/'+target.remote+'/'+target.remoteBranch;
	if(backend==='native'){
		const run=await checkedNative(dir);
		const auth=credentials && Buffer.from(credentials.username+':'+credentials.password).toString('base64');
		if(operation==='push')await run(['push','--no-verify','--porcelain',target.url,preview.head+':'+remoteRef],auth);
		else await run(['fetch','--no-tags','--no-recurse-submodules',target.url,remoteRef+':'+tracking],auth);
	}else{
		const args={...repo,http:transport(target.url),url:target.url,remote:target.remote,remoteRef:target.remoteBranch,
			onAuth:()=>credentials,ref:preview.branch};
		if(operation==='push')await git.push(args);
		else await git.fetch({...args,tags:false,singleBranch:true});
	}
}

export async function tree(dir:string,oid:string) {
	const repo=repository(dir),files=new Map<string,string>(),names=new Set<string>();
	async function visit(prefix:string,ref:string) {
		for(const entry of (await git.readTree({...repo,oid:ref})).tree){
			const name=entry.path, relative=prefix+name;
			if(!name || Array.from(name).some(c=>c.charCodeAt(0)<32) || /[<>:"/\\|?*]/u.test(name) || /[. ]$/u.test(name) ||
				/^(?:\.git(?:attributes|modules)?|git~\d+|\.\.?|(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?)$/iu.test(name) ||
				!['040000','100644','100755'].includes(entry.mode))throw new Error(fromEnglish('Unsupported path in target tree: ','目标树包含不受支持的路径：')+relative);
			const key=relative.normalize('NFC').toLowerCase();
			if(names.has(key))throw new Error(fromEnglish('Path collision: ','路径冲突：')+relative);
			names.add(key);
			if(entry.type==='tree')await visit(relative+'/',entry.oid);
			else files.set(relative,entry.oid+':'+entry.mode);
		}
	}
	await visit('',oid);
	return files;
}

export async function changePlan(dir:string,ref:string){
	const {preview}=await remoteState(dir),repo=repository(dir);
	if(preview.changes.length || !preview.head)throw new Error(fromEnglish('Commit or store all changes before switching or pulling.','切换或拉取前请先提交或妥善保存所有变更。'));
	const oid=await git.resolveRef({...repo,ref});
	const [before,after]=await Promise.all([tree(dir,preview.head),tree(dir,oid)]);
	if(!before.has('kb-manager.json') || before.get('kb-manager.json')!==after.get('kb-manager.json'))throw new Error(fromEnglish('Incoming history changes the knowledge base identity. Review externally.','目标历史会修改知识库身份，请在外部核对。'));
	const changes=[...new Set([...before.keys(),...after.keys()])].filter(f=>before.get(f)!==after.get(f));
	for(const file of before.keys())if(((await statIfPresent(path.join(dir,file)))?.nlink??1)>1)throw new Error(fromEnglish('Working tree contains a hard link: ','工作区含硬链接：')+file);
	for(const file of changes)if(!before.has(file)){
		try {await fs.lstat(path.join(dir,file));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
		throw new Error(fromEnglish('Incoming path already exists: ','目标路径已存在：')+file);
	}
	return {ref,oid,head:preview.head,branch:preview.branch,changes,identity:preview.identity};
}

export async function applyChange(dir:string,plan:Awaited<ReturnType<typeof changePlan>>,operation:'switch'|'pull',backend:Backend,method:SyncMethod,strategy:'none'|'ours'|'theirs'='none'){
	const fresh=await changePlan(dir,plan.ref);
	if(JSON.stringify(fresh)!==JSON.stringify(plan))throw new Error(fromEnglish('Repository changed. Preview again.','仓库已变化，请重新预览。'));
	const repo=repository(dir);
	if(operation==='switch'){
		if(!plan.ref.startsWith('refs/heads/'))throw new Error(fromEnglish('Choose a local branch','请选择本地分支'));
		const branch=refName(plan.ref.slice(11));
		if(backend==='native')await (await checkedNative(dir))(['switch','--no-recurse-submodules',branch]);
		else await git.checkout({...repo,ref:branch});
		return;
	}
	if(plan.oid===plan.head || await git.isDescendent({...repo,oid:plan.head,ancestor:plan.oid}))return;
	if(backend==='native'){
		const run=await checkedNative(dir);
		const overrides:string[]=[];
		const needsIdentity=method!=='ff-only' && !await git.isDescendent({...repo,oid:plan.oid,ancestor:plan.head});
		if(needsIdentity){
			const identity=requireIdentity(fresh.identity);
			overrides.push('-c','user.name='+identity.name,'-c','user.email='+identity.email);
		}
		if(method==='rebase')await run([...overrides,'rebase','--no-autostash',plan.oid]);
		else await run([...overrides,'merge','--no-edit',method==='ff-only'?'--ff-only':'--ff',
			...(method==='merge' && strategy!=='none'?['-X',strategy]:[]),plan.oid]);
		return;
	}
	if(method!=='ff-only')throw new Error(fromEnglish('This pull method requires native Git','此拉取方式需要原生 Git'));
	if(!await git.isDescendent({...repo,oid:plan.oid,ancestor:plan.head}))throw new Error(fromEnglish('Branches diverged. Fast-forward is unavailable.','分支已分叉，无法快进。'));
	const ref='refs/heads/'+plan.branch;
	const dest=path.join(repo.gitdir,ref);
	await fs.mkdir(path.dirname(dest),{recursive:true});
	const lock=await fs.open(dest+'.lock','wx');
	try{
		if(await git.resolveRef({...repo,ref})!==plan.head)throw new Error(fromEnglish('Current branch changed','当前分支已变化'));
		await lock.writeFile(plan.oid+'\n');
		await git.checkout({...repo,ref:plan.oid,noUpdateHead:true});
		await lock.close();
		await fs.rename(dest+'.lock',dest);
	}catch(error){
		await lock.close();await fs.rm(dest+'.lock',{force:true});throw error;
	}
}

export async function createBranch(dir:string,name:string){
	if(!(await remoteState(dir)).preview.head)throw new Error(fromEnglish('Create a first commit before branching','请先创建首个提交，再创建分支'));
	await git.branch({...repository(dir),ref:refName(name)});
}
