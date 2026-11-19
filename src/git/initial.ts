import * as path from 'node:path';
import { userInfo } from 'node:os';
import { statIfPresent } from '../fs/vault.ts';
import { identityFile } from '../kb/identity-core.ts';
import { tr } from '../i18n.ts';
import { guardGit } from './guard.ts';
import { checkedIdentityArgs, readGlobalIdentityFields, readRepositoryIdentity, requireIdentity } from './identity.ts';
import type { GitIdentity } from './identity.ts';
import { withIndex } from './index-transaction.ts';
import { endpoint } from './network-http.ts';
import { gitResult } from './network-native.ts';
import { fields, headOid, readCommit, text } from './repository.ts';

type IdentitySource = 'global'|'login'|'environment'|'placeholder'|'local';
interface InitialField { value:string; source:IdentitySource; origin?:string }
export interface InitialIdentity { name:InitialField; email:InitialField }
export interface InitialDraft { defaults:InitialIdentity; values:GitIdentity; origin:string }
export interface InitialConfig { identity:InitialIdentity; origin:string }
interface InitialTree { tree:string; staged:string[]; ignored:string[] }
export type InitialPreview = InitialConfig & InitialTree;

const keys=['name','email'] as const;
export const initialMessage='Initial commit';
const changed=()=>new Error(tr('Git 身份、忽略规则或待提交文件已变化，请重新预览。','Git identity, ignore rules or initial commit files changed. Preview again.'));

export async function initialIdentityDefaults():Promise<InitialIdentity>{
	const global=await readGlobalIdentityFields();
	const inherited=(key:keyof GitIdentity):InitialField|undefined=>{
		const field=global[key],value=field?.value.trim();
		return value?{value,source:'global',origin:field?.origin}:undefined;
	};
	const name=inherited('name'),email=inherited('email');
	const env=process.env.EMAIL?.trim()??'';
	const validEnv=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(env) && !Array.from(env).some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127);
	const login=(!name || (!email && !validEnv))?userInfo().username:'';
	const slug=login.replace(/[^\p{L}\p{N}_.+-]+/gu,'.').replace(/\.{2,}/gu,'.').replace(/^\.|\.$/gu,'');
	return {
		name:name??{value:login,source:'login'},
		email:email??(validEnv?{value:env,source:'environment',origin:'EMAIL'}:{value:(slug||'user')+'@users.invalid',source:'placeholder'}),
	};
}

export async function initialConfig(draft?:InitialDraft):Promise<InitialConfig>{
	const fresh=await initialIdentityDefaults();
	const choose=(key:keyof GitIdentity):InitialField=>{
		const value=draft?.values[key].trim(),shown=draft?.defaults[key];
		if(value && value!==shown?.value)return {value,source:'local'};
		if(shown && JSON.stringify(shown)!==JSON.stringify(fresh[key]))throw changed();
		return fresh[key];
	};
	const identity={name:choose('name'),email:choose('email')};
	requireIdentity({name:identity.name.value,email:identity.email.value});
	const raw=draft?.origin.trim()??'',origin=raw?endpoint(raw):'';
	if(origin.startsWith('http:'))throw new Error(tr('origin 需要 HTTPS 或 SSH 地址','Use an HTTPS or SSH address for origin'));
	return {identity,origin};
}

async function resolvedInitialIdentity(dir:string,identity:InitialIdentity):Promise<InitialIdentity>{
	const current=await readRepositoryIdentity(dir);
	const read=(key:keyof GitIdentity):InitialField=>{
		const expected=identity[key],resolved=current.values[key].at(-1);
		if(expected.source==='global'){
			const value=resolved?.value.trim();
			if(!value || resolved?.scope!=='global' || current.local[key]!=='')throw changed();
			return {value,source:'global',origin:resolved.origin};
		}
		if(!resolved?.direct || resolved.value.trim()!==expected.value)throw changed();
		return expected;
	};
	return {name:read('name'),email:read('email')};
}

const signature=(identity:InitialIdentity)=>({name:identity.name.value,email:identity.email.value});

async function confirmNoContentFilter(dir:string,paths:string[],indexFile?:string){
	if(!paths.length)return;
	const input=paths.join('\0')+'\0';
	const attributes=(await gitResult(dir,['check-attr','-z','--stdin','filter'],{stdin:input,indexFile})).stdout.toString().split('\0');
	attributes.pop();
	if(attributes.length!==paths.length*3 || attributes.some((value,i)=>i%3===2 && value!=='' && value!=='unspecified' && value!=='unset'))
		throw new Error(tr('待提交文件使用 Git 内容过滤器，请检查属性和全局 Git 配置。','An initial commit file uses a Git content filter. Review attributes and global Git configuration.'));
}

async function stageInitialTree(dir:string,paths:string[],indexFile:string):Promise<InitialTree>{
	const options={indexFile};
	await gitResult(dir,['read-tree','--empty'],options);
	const untracked=['ls-files','-z','--others','--exclude-standard'];
	const [otherResult,ignoredResult]=await Promise.all([gitResult(dir,untracked,options),gitResult(dir,[...untracked,'--ignored'],options)]);
	const eligible=fields(otherResult.stdout).sort(),ignored=fields(ignoredResult.stdout).sort();
	if(!ignored.includes(identityFile) || JSON.stringify([...eligible,...ignored].sort())!==JSON.stringify(paths))throw changed();
	if(eligible.length){
		await confirmNoContentFilter(dir,eligible,indexFile);
		const stdin=eligible.join('\0')+'\0';
		await gitResult(dir,['add','--pathspec-from-file=-','--pathspec-file-nul'],{stdin,indexFile});
	}
	const staged=fields((await gitResult(dir,['ls-files','-z','--cached'],options)).stdout).sort();
	if(JSON.stringify(staged)!==JSON.stringify(eligible))throw changed();
	const tree=(await gitResult(dir,['write-tree'],options)).stdout.toString('ascii').trim();
	return {tree,staged,ignored};
}

export async function previewInitialRepository(dir:string,paths:string[],config:InitialConfig):Promise<InitialPreview>{
	await gitResult(dir,['init','--quiet','--template=','--initial-branch=main','--object-format=sha1']);
	const local=(key:string,value:string)=>gitResult(dir,['config','--local','--',key,value]);
	for(const key of keys){
		const field=config.identity[key];
		if(field.source!=='global')await local('user.'+key,field.value);
	}
	if(config.origin){
		await local('remote.origin.url',config.origin);
		await local('remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*');
	}
	return reviewInitialRepository(dir,paths,config);
}

async function verifyLocalOrigin(dir:string,expected:string){
	const entries=fields((await gitResult(dir,['config','--local','--null','--list'])).stdout);
	const actual=entries.filter(entry=>entry.startsWith('remote.origin.'));
	if(entries.some(entry=>entry.startsWith('branch.main.')) || JSON.stringify(actual.sort())!==JSON.stringify(expected?
		['remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*','remote.origin.url\n'+expected]:[]))throw changed();
}

async function readInitialPreview(dir:string,paths:string[],config:InitialConfig,indexFile:string,locks:Set<string>):Promise<InitialPreview>{
	if(await guardGit(dir,locks)!=='main' || await headOid(dir) || await statIfPresent(path.join(dir,'.git','index')) ||
		await text(dir,['for-each-ref','--format=%(refname)']))throw changed();
	await verifyLocalOrigin(dir,config.origin);
	const identity=await resolvedInitialIdentity(dir,config.identity);
	await checkedIdentityArgs(dir,signature(identity));
	return {identity,origin:config.origin,...await stageInitialTree(dir,paths,indexFile)};
}

export function reviewInitialRepository(dir:string,paths:string[],config:InitialConfig){
	return withIndex(dir,async(index,locks)=>{
		return readInitialPreview(dir,paths,config,index,locks);
	});
}

const ref='refs/heads/main';
async function verifyCommit(dir:string,oid:string,preview:InitialPreview){
	const {commit}=await readCommit(dir,oid);
	if(commit.parent.length || commit.tree!==preview.tree || commit.message!==initialMessage+'\n' ||
		[commit.author,commit.committer].some(person=>person.name!==preview.identity.name.value || person.email!==preview.identity.email.value))throw changed();
}

export async function commitInitialRepository(dir:string,paths:string[],preview:InitialPreview){
	const oid=await withIndex(dir,async(indexFile,locks,publish)=>{
		const actual=await readInitialPreview(dir,paths,preview,indexFile,locks);
		if(JSON.stringify(actual)!==JSON.stringify(preview))throw changed();
		const args=await checkedIdentityArgs(dir,signature(actual.identity));
		const oid=(await gitResult(dir,[...args,'commit-tree','--no-gpg-sign',actual.tree,'-F','-'],{stdin:initialMessage+'\n'})).stdout.toString('ascii').trim();
		await verifyCommit(dir,oid,preview);
		await gitResult(dir,['update-ref','-m','commit (initial): '+initialMessage,ref,oid,'0'.repeat(40)]);
		await publish();
		return oid;
	});
	await verifyInitialRepository(dir,oid,preview);
	return oid;
}

export async function verifyInitialRepository(dir:string,oid:string,preview:InitialPreview){
	await guardGit(dir);
	await verifyCommit(dir,oid,preview);
	await verifyLocalOrigin(dir,preview.origin);
	await confirmNoContentFilter(dir,preview.staged);
	const [refs,branch,status,ignored]=await Promise.all([
		text(dir,['for-each-ref','--format=%(refname) %(objectname)']),text(dir,['symbolic-ref','HEAD']),
		text(dir,['status','--porcelain=v1','--untracked-files=all']),gitResult(dir,['ls-files','-z','--others','--ignored','--exclude-standard']),
	]);
	if(refs!==ref+' '+oid || branch!==ref || status || JSON.stringify(fields(ignored.stdout).sort())!==JSON.stringify(preview.ignored))throw changed();
}
