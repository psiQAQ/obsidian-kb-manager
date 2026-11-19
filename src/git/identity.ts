import git from 'isomorphic-git';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { digest, statIfPresent } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { repository } from './repository.ts';
import { updateConfig } from './network-config.ts';

export interface GitIdentity { name:string; email:string; indirect?:true }
export interface IdentityPreview { identity:GitIdentity; config:string }

async function localConfig(dir:string) {
	const gitdir=join(dir,'.git');
	if(!(await statIfPresent(gitdir))?.isDirectory() || await statIfPresent(join(gitdir,'commondir')) || await statIfPresent(join(gitdir,'gitdir')))
		throw new Error(tr('需要本库独立的 Git 仓库','This library needs its own Git repository'));
	const file=join(gitdir,'config');
	const stat=await fs.lstat(file);
	if(!stat.isFile() || stat.nlink!==1)throw new Error(tr('需要库内独立的 Git 配置文件','Expected a regular local Git configuration file'));
	const handle=await fs.open(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try{
		const opened=await handle.stat();
		if(!opened.isFile() || opened.nlink!==1 || opened.ino!==stat.ino || opened.dev!==stat.dev)
			throw new Error(tr('Git 配置文件已变化','Git configuration file changed'));
		return await handle.readFile();
	}finally{await handle.close();}
}

async function indirectConfig(dir:string,bytes:Buffer){
	return /^\s*\[\s*(?:include|includeif|extensions)\b/imu.test(bytes.toString('utf8')) ||
		!!await statIfPresent(join(dir,'.git','config.worktree')) || !!await statIfPresent(join(dir,'.git','worktrees'));
}

export function indirectIdentityMessage(){
	return tr('此库使用包含文件、扩展或工作树配置，无法确认有效的 Git 身份。请在原有 Git 工作流中查看或修改。','Includes, extensions or worktree configuration can change the effective Git identity. Review or edit this repository with Git.');
}

export async function readRepositoryIdentity(dir:string):Promise<IdentityPreview> {
	const bytes=await localConfig(dir);
	// Both keys and the preview fingerprint come from the same local file snapshot.
	const text=bytes.toString('utf8')
		.replace(/(^|[^\\])((?:\\\\)*)\\\r?\n/gmu,'$1$2')
		.replace(/^([ \t]*(?:name|email))[ \t]*(?:[#;][^\n]*)?\r?$/gimu,'$1 =');
	const repo={...repository(dir),fs:{promises:{...fs,readFile:()=>Promise.resolve(text)}}};
	const read=async(key:string)=>{
		const value:unknown=await git.getConfig({...repo,path:'user.'+key});
		return typeof value==='string'?value:'';
	};
	const [name,email]=await Promise.all([read('name'),read('email')]);
	const identity:GitIdentity={name,email};
	if(await indirectConfig(dir,bytes))identity.indirect=true;
	return {identity,config:digest(bytes)};
}

export function requireIdentity(value:GitIdentity):GitIdentity {
	if(value.indirect)throw new Error(indirectIdentityMessage());
	const name=value.name.trim(),email=value.email.trim();
	if(!name || !email)throw new Error(tr('请在本库 Git 设置 → 身份与凭据中填写 user.name 和 user.email','Set user.name and user.email in Library Git settings → Identity and credentials'));
	if([name,email].some(field=>Array.from(field).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127 || c==='<' || c==='>')))
		throw new Error(tr('Git 身份含无效的控制字符或尖括号','Git identity contains a control character or angle bracket'));
	return {name,email};
}

export async function writeRepositoryIdentity(dir:string,preview:IdentityPreview,draft:GitIdentity) {
	const identity=requireIdentity(draft);
	const current=await localConfig(dir);
	if(digest(current)!==preview.config)throw new Error(tr('仓库配置已变化，请重新预览','Repository configuration changed. Preview again.'));
	if(await indirectConfig(dir,current))throw new Error(indirectIdentityMessage());
	// The config writer edits physical lines. Preserve existing continued values.
	if(/(?:^|[^\\])(?:\\\\)*\\\r?\n/mu.test(current.toString('utf8')))
		throw new Error(tr('此 Git 配置含续行，请用 Git 修改作者身份','This config uses continued lines. Edit its identity with Git.'));
	await updateConfig(dir,preview.config,async repo=>{
		for(const key of ['name','email'] as const){
			const path='user.'+key;
			if((await git.getConfigAll({...repo,path})).length>1)throw new Error(tr('同一配置项含多个值，请用 Git 核对：','Review duplicate values in Git for ')+path);
			if(preview.identity[key]!==identity[key])await git.setConfig({...repo,path,value:identity[key]});
		}
	});
}
