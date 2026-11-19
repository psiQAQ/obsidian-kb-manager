import git from 'isomorphic-git';
import {tr} from '../i18n.ts';
import {identityFile} from '../kb/identity-core.ts';
import type {Template} from '../kb/template-core.ts';
import {decode} from './disk.ts';
import {ignoredParents,localAuthor,mobileStatus,repo} from './git.ts';
import type {Author,Store} from './git.ts';

export const initialBranch='main';
export const initialMessage='Initial commit';
type Files=Template['files'];
interface InitialPlan {files:Files;author:Author;origin?:string}

export async function previewInitialFiles(s:Store,files:Files){
	const rules=new Map(files.filter(file=>file.name.split('/').at(-1)==='.gitignore')
		.map(file=>[s.root+'/'+file.name,decode(file.bytes)]));
	// Use the same ignore matcher as staging, with the proposed ignore files
	// projected into an otherwise empty worktree. Preview writes no files.
	const r=repo({...s,disk:{...s.disk,
		stat:async path=>rules.has(path)?{type:'file',size:0,ctime:0,mtime:0}:null,
		read:async path=>rules.get(path)!,
	}});
	if(!await git.isIgnored({...r,filepath:identityFile}))throw verificationError();
	const ignoredParent=ignoredParents(r);
	const eligible=[];
	for(const file of files)if(file.name!==identityFile && !await ignoredParent(file.name) && !await git.isIgnored({...r,filepath:file.name}))eligible.push(file);
	return eligible;
}

const verificationError=()=>new Error(tr('初始提交与预览不一致','The initial commit does not match the preview'));
function sameFiles(actual:string[],expected:Files){
	const names=expected.map(file=>file.name).sort();
	return actual.length===names.length && actual.sort().every((name,i)=>name===names[i]);
}

function initialConfig({author,origin}:InitialPlan){
	return {'user.name':author.name,'user.email':author.email,...(origin?{
		'remote.origin.url':origin,'remote.origin.fetch':'+refs/heads/*:refs/remotes/origin/*',
	}:{})};
}

export async function initializeMobileGit(s:Store,plan:InitialPlan){
	const r=repo(s);
	await git.init({...r,defaultBranch:initialBranch});
	const state=await mobileStatus(s);
	if(!sameFiles(state.changes.map(change=>change.file),plan.files))throw verificationError();
	// The repository is in a unique scratch directory until the commit is verified.
	for(const [path,value] of Object.entries(initialConfig(plan)))await git.setConfig({...r,path,value});
	if(plan.files.length)await git.add({...r,filepath:plan.files.map(file=>file.name)});
	if(!sameFiles(await git.listFiles(r),plan.files))throw verificationError();
	await git.commit({...r,author:plan.author,committer:plan.author,message:initialMessage});
	return verifyInitialCommit(s,plan);
}

export async function verifyInitialCommit(s:Store,plan:InitialPlan){
	const r=repo(s),status=await mobileStatus(s);
	if(status.branch!==initialBranch || !status.head || status.changes.length || !await git.isIgnored({...r,filepath:identityFile}) ||
		!sameFiles(await git.listFiles(r),plan.files))throw verificationError();
	const {commit}=await git.readCommit({...r,oid:status.head});
	if(commit.parent.length || commit.message.trimEnd()!==initialMessage || [commit.author,commit.committer,await localAuthor(s)]
		.some(person=>person.name!==plan.author.name || person.email!==plan.author.email))throw verificationError();
	const blobs=new Map<string,string>();
	await git.walk({...r,trees:[git.TREE({ref:status.head})],map:async(path,[entry])=>{
		if(entry && await entry.type()==='blob')blobs.set(path,await entry.oid());
		return undefined;
	}});
	if(blobs.size!==plan.files.length)throw verificationError();
	for(const file of plan.files){
		if(blobs.get(file.name)!==(await git.hashBlob({object:file.bytes})).oid)throw verificationError();
	}
	const remotes=await git.listRemotes(r);
	if(plan.origin?remotes.length!==1 || remotes[0]?.remote!=='origin' || remotes[0].url!==plan.origin:remotes.length)throw verificationError();
	for(const path of ['branch.main.remote','branch.main.merge'])
		if((await git.getConfigAll({...r,path})).length)throw verificationError();
	for(const [path,value] of Object.entries(initialConfig(plan)))
		if(await git.getConfig({...r,path})!==value)throw verificationError();
	return {branch:status.branch,head:status.head,author:plan.author,origin:plan.origin};
}
