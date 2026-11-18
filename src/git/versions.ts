import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import git from 'isomorphic-git';
import { digest, statIfPresent } from '../fs/vault.ts';
import { guardGit } from './guard.ts';
import { repository } from './repository.ts';

export interface Change { file: string; head: number; work: number; stage: number; fingerprint?: string }
export interface VersionPreview {
	head: string; branch: string; signature: string; staged: boolean; changes: Change[];
	files: number; bytes: number; elapsed: number;
}

export async function previewVersion(dir: string): Promise<VersionPreview> {
	const start=Date.now(), repo=repository(dir);
	const branch=await guardGit(dir);
	let head='';
	try { head=await git.resolveRef({...repo,ref:'HEAD'}); }
	catch(error){if (!(error instanceof git.Errors.NotFoundError))throw error;}
	const index=path.join(repo.gitdir,'index');
	const indexHash=await statIfPresent(index) ? digest(await fs.readFile(index)) : '';
	const matrix=await git.statusMatrix({...repo,refresh:false});
	const changes: Change[]=[];
	let bytes=0;
	for(const [file,h,w,s] of matrix){
		if(h===w && w===s)continue;
		let fingerprint: string | undefined;
		if(w){
			const data=await fs.readFile(path.join(dir,file));
			fingerprint=digest(data); bytes+=data.length;
		}
		changes.push({file,head:h,work:w,stage:s,fingerprint});
	}
	const signature=digest(JSON.stringify([branch,head,indexHash,changes]));
	return {head,branch,signature,staged:changes.some(c=>c.head!==c.stage),changes,files:matrix.length,bytes,elapsed:Date.now()-start};
}

export async function saveVersion(dir: string, confirmed: VersionPreview, message: string, author: {name:string;email:string}) {
	if(!message.trim() || !author.name.trim() || !author.email.trim())throw new Error('请填写提交说明及本地作者姓名和邮箱');
	const fresh=await previewVersion(dir);
	if(fresh.signature!==confirmed.signature)throw new Error('HEAD、索引或工作区已变化，请重新预览');
	if(!fresh.changes.length)throw new Error('没有可提交的变更');
	const repo=repository(dir), done: string[]=[];
	try {
		if(!fresh.staged)for(const change of fresh.changes){
			if(change.work){
				const bytes=await fs.readFile(path.join(dir,change.file));
				if(digest(bytes)!==change.fingerprint)throw new Error('文件已变化：'+change.file);
				await git.add({...repo,filepath:change.file});
			}else{
				if(await statIfPresent(path.join(dir,change.file)))throw new Error('文件已恢复：'+change.file);
				await git.remove({...repo,filepath:change.file});
			}
			done.push(change.file);
		}
		return await git.commit({...repo,message:message.trim(),author,disallowEmpty:true});
	} catch(error){
		throw new Error(String(error)+'；本次已暂存：'+(done.join(', ') || '无')+'。请重新查看 HEAD 和暂存区。');
	}
}

export async function history(dir: string, cursor?: string, size=20) {
	await guardGit(dir);
	const repo=repository(dir);
	let ref=cursor;
	if(!ref)try{ref=await git.resolveRef({...repo,ref:'HEAD'});}catch(error){if(error instanceof git.Errors.NotFoundError)return {entries:[],next:undefined};throw error;}
	const entries=await git.log({...repo,ref,depth:size+1});
	return {entries:entries.slice(0,size),next:entries[size]?.oid};
}
