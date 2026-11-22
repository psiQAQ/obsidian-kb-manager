import * as fs from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { digest, statIfPresent } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { gitResult } from './network-native.ts';
import { updateConfig } from './network-config.ts';

export interface GitIdentity { name:string; email:string }
export interface IdentityValue { scope:string; origin:string; value:string; direct:boolean }
export interface IdentityPreview {
	identity:GitIdentity; local:GitIdentity; config:string; shared:boolean;
	values:{name:IdentityValue[];email:IdentityValue[]};
}
const keys=['name','email'] as const;

async function configFile(dir:string){
	const gitdir=join(dir,'.git'),file=join(gitdir,'config');
	if(!(await statIfPresent(gitdir))?.isDirectory() || await statIfPresent(join(gitdir,'commondir')) || await statIfPresent(join(gitdir,'gitdir')))
		throw new Error(tr('需要独立的库内 Git 仓库','A standalone library repository is required'));
	const stat=await fs.lstat(file);
	if(!stat.isFile() || stat.nlink!==1)throw new Error(tr('需要独立的本地 Git 配置文件','Expected an ordinary local Git config file'));
	return file;
}
async function values(dir:string|undefined,file:string|undefined,key:string){
	const args=['config',...(dir?[]:['--global']),'--includes','--show-scope','--show-origin','--null','--get-all','user.'+key];
	const {stdout}=await gitResult(dir,args,{allowedExitCodes:[0,1]});
	const tokens=stdout.toString('utf8').split('\0');
	tokens.pop();
	const result:IdentityValue[]=[];
	for(let i=0;i<tokens.length;i+=3){
		const scope=tokens[i]!,origin=tokens[i+1]!,value=tokens[i+2]!;
		const candidate=dir && origin.startsWith('file:')?normalize(resolve(dir,origin.slice(5))):'';
		const direct=file!==undefined && scope==='local' && (process.platform==='win32'?candidate.toLowerCase()===file.toLowerCase():candidate===file);
		result.push({scope,origin,value,direct});
	}
	return result;
}
export async function readGlobalIdentityFields(){
	const [name,email]=await Promise.all(keys.map(key=>values(undefined,undefined,key)));
	return {name:name?.at(-1),email:email?.at(-1)};
}
export async function readRepositoryIdentity(dir:string):Promise<IdentityPreview>{
	const file=await configFile(dir),bytes=await fs.readFile(file),config=digest(bytes);
	const shared=/^\s*\[\s*(?:include|includeif|extensions)\b/imu.test(bytes.toString('utf8')) ||
		!!await statIfPresent(join(dir,'.git','config.worktree')) || !!await statIfPresent(join(dir,'.git','worktrees'));
	const [name,email]=await Promise.all(keys.map(key=>values(dir,file,key)));
	const all={name:name!,email:email!},identity={name:'',email:''},local={name:'',email:''};
	for(const key of keys){
		for(const field of all[key]){
			identity[key]=field.value;
			if(field.direct)local[key]=field.value;
		}
	}
	if(config!==digest(await fs.readFile(file)))throw new Error(tr('身份已变化，请刷新','Identity changed. Refresh the preview.'));
	return {identity,local,values:all,config,shared};
}
function validateField(value:string){
	if(Array.from(value).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127 || c==='<' || c==='>'))
		throw new Error(tr('Git 身份含无效字符','Invalid character in Git identity'));
}
export function requireIdentity(value:GitIdentity):GitIdentity{
	const name=value.name.trim(),email=value.email.trim();
	if(!name || !email)throw new Error(tr('请在 Git 配置中设置 user.name 和 user.email','Set user.name and user.email in Git configuration'));
	validateField(name);validateField(email);
	return {name,email};
}

// Git can choose distinct authors and committers via configuration or the app
// environment. Only publish a signature which the plugin actually previewed.
export async function checkedIdentityArgs(dir:string,preview:GitIdentity):Promise<string[]>{
	const {name,email}=requireIdentity(preview),expected=name+' <'+email+'>';
	const roles=['GIT_AUTHOR_IDENT','GIT_COMMITTER_IDENT'];
	for(const role of roles){
		const output=await gitResult(dir,['var',role],{allowedExitCodes:[0,128]});
		const ident=output.stdout.toString('utf8').trimEnd().replace(/ -?\d+ [+-]\d{4}$/u,'');
		if(output.code || ident!==expected){
			throw new Error(tr('Git 的实际身份与预览不同，请用系统 Git 提交，或核对作者、提交者设置和环境变量。','Git resolves a different identity than the preview. Commit with system Git or review author, committer and environment settings.')+' '+role+
				(ident?' · '+ident:''));
		}
	}
	// Pin both roles for the command even if another process changes the Git configuration.
	return ['user','author','committer'].flatMap(key=>['-c',key+'.name='+name,'-c',key+'.email='+email]);
}
export function identityAfter(preview:IdentityPreview,key:keyof GitIdentity,local:string):IdentityValue|undefined{
	const entries=preview.values[key],effective=entries.at(-1),direct=entries.map(e=>e.direct).lastIndexOf(true);
	const inherited=entries.filter(e=>!e.direct);
	if(!local)return inherited[inherited.length-1];
	if(direct>=0 && direct<entries.length-1)return effective;
	if(direct<0 && (effective?.scope==='worktree' || effective?.scope==='command'))return effective;
	return {scope:'local',origin:'.git/config',value:local,direct:true};
}
export function repositoryIdentityChanges(preview:IdentityPreview,draft:GitIdentity) {
	return keys.filter(key=>{
		const next=draft[key].trim();
		return next!==preview.local[key] || !next && preview.values[key].some(v=>v.direct);
	});
}
export async function writeRepositoryIdentity(dir:string,preview:IdentityPreview,draft:GitIdentity){
	const fresh=await readRepositoryIdentity(dir);
	if(fresh.shared)throw new Error(tr('此库含特殊的本地配置，请使用 Git 修改','This repository has special local configuration. Edit it with Git.'));
	if(fresh.config!==preview.config || JSON.stringify(fresh.values)!==JSON.stringify(preview.values))
		throw new Error(tr('仓库配置或继承身份已变化，请重新预览','Repository configuration or inherited identity changed. Preview again.'));
	const changes=repositoryIdentityChanges(preview,draft);
	for(const key of changes)validateField(draft[key]);
	if(!changes.length)return;
	await updateConfig(dir,preview.config,async shadow=>{
		for(const key of changes){
			const file=join(shadow.gitdir,'config'),next=draft[key].trim(),field='user.'+key;
			const args=next?['--replace-all',field,next]:['--unset-all',field];
			await gitResult(dir,['config','--file',file,'--no-includes',...args]);
		}
	});
}
