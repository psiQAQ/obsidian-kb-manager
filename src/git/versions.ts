import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import git from 'isomorphic-git';
import { digest, statIfPresent } from '../fs/vault.ts';
import { guardGit } from './guard.ts';
import { repository } from './repository.ts';

export interface Change { file: string; head: number; work: number; stage: number; fingerprint?: string }
export interface VersionPreview {
	head: string; branch: string; signature: string; staged: boolean; changes: Change[];
	files: number; bytes: number; elapsed: number; platform: string;
}

export async function previewVersion(dir: string, ownLocks: ReadonlySet<string> = new Set()): Promise<VersionPreview> {
	const start=Date.now(), repo=repository(dir);
	const branch=await guardGit(dir,ownLocks);
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
	return {head,branch,signature,staged:changes.some(c=>c.head!==c.stage),changes,files:matrix.length,bytes,elapsed:Date.now()-start,platform:process.platform};
}

export interface SaveRecord {
	head:string; branch:string; message:string; candidate?:string; committed?:string; staged:string[]; problem?:string;
}
export async function saveVersion(dir: string, confirmed: VersionPreview, message: string, author: {name:string;email:string}, record?:(value:SaveRecord)=>Promise<void>) {
	if(!message.trim() || !author.name.trim() || !author.email.trim())throw new Error('请填写提交说明及本地作者姓名和邮箱');
	const branch=await guardGit(dir);
	if(branch!==confirmed.branch)throw new Error('当前分支已变化');
	const repo=repository(dir), done: string[]=[];
	const locks = new Map<string,fs.FileHandle>();
	const expectedBlobs=new Map<string,string>();
	const receipt:SaveRecord={head:confirmed.head,branch,message,staged:done};
	try {
		const ref='refs/heads/'+branch;
		await fs.mkdir(path.dirname(path.join(repo.gitdir,ref)),{recursive:true});
		for(const relative of ['index.lock','HEAD.lock',ref+'.lock']) {
			const file=path.join(repo.gitdir,relative);
			locks.set(file,await fs.open(file,'wx'));
		}
		const fresh=await previewVersion(dir,new Set(locks.keys()));
		if(fresh.signature!==confirmed.signature)throw new Error('HEAD、索引或工作区已变化，请重新预览');
		if(!fresh.changes.length)throw new Error('没有可提交的变更');
		await record?.(receipt);
		if(!fresh.staged)for(const change of fresh.changes){
			if(change.work){
				const bytes=await fs.readFile(path.join(dir,change.file));
				if(digest(bytes)!==change.fingerprint)throw new Error('文件已变化：'+change.file);
				await git.add({...repo,filepath:change.file});
				expectedBlobs.set(change.file,(await git.hashBlob({object:bytes})).oid);
			}else{
				if(await statIfPresent(path.join(dir,change.file)))throw new Error('文件已恢复：'+change.file);
				await git.remove({...repo,filepath:change.file});
			}
			done.push(change.file);
		}
		if(expectedBlobs.size){
			await git.walk({...repo,trees:[git.STAGE()],map:async(file,[entry])=>{
				if(expectedBlobs.has(file)){
					if(!entry || await entry.oid()!==expectedBlobs.get(file))throw new Error('暂存内容已变化：'+file);
					expectedBlobs.delete(file);
				}
			}});
			if(expectedBlobs.size)throw new Error('预览的文件未全部暂存');
		}
		const timestamp=Math.floor(Date.now()/1000);
		const identity={...author,timestamp,timezoneOffset:new Date().getTimezoneOffset()};
		const args={...repo,message:message.trim(),author:identity,committer:identity,disallowEmpty:true};
		receipt.candidate=await git.commit({...args,noUpdateBranch:true});
		await record?.(receipt);
		const oid=await git.commit(args);
		receipt.committed=oid;
		await record?.(receipt);
		return oid;
	} catch(error){
		receipt.problem=String(error);
		await record?.(receipt);
		throw new Error(String(error)+'；本次已暂存：'+(done.join(', ') || '无')+'。请重新查看 HEAD 和暂存区。');
	} finally {
		for(const [file,handle] of [...locks].reverse()){
			const expected=await handle.stat({bigint:true});
			await handle.close();
			const current=await fs.lstat(file,{bigint:true}).catch(()=>undefined);
			if(current?.dev===expected.dev && current.ino===expected.ino)await fs.unlink(file);
		}
	}
}

export async function history(dir: string, cursor?: string, size=20) {
	await guardGit(dir,new Set(),true);
	const repo=repository(dir);
	let ref=cursor;
	if(!ref)try{ref=await git.resolveRef({...repo,ref:'HEAD'});}catch(error){if(error instanceof git.Errors.NotFoundError)return {entries:[],next:undefined};throw error;}
	const entries=await git.log({...repo,ref,depth:size+1});
	return {entries:entries.slice(0,size),next:entries[size]?.oid};
}
