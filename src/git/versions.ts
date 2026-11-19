import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import git from 'isomorphic-git';
import { digest, statIfPresent } from '../fs/vault.ts';
import { guardGit } from './guard.ts';
import { repository } from './repository.ts';
import { readRepositoryIdentity, requireIdentity } from './identity.ts';
import type { GitIdentity } from './identity.ts';

export interface Change { file: string; head: number; work: number; stage: number; fingerprint?: string; workBytes?: number }
export interface VersionPreview {
	head: string; branch: string; signature: string; staged: boolean; changes: Change[]; identity:GitIdentity;
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
		if(path.win32.isAbsolute(file) || /[\\:\0]/u.test(file) ||
			file.split('/').some(part=>!part || part==='..' || part==='.' || part.toLowerCase()==='.git')){
			throw new Error(tr('Git 返回了不安全的文件路径','Git returned an unsafe file path'));
		}
		let fingerprint: string | undefined;
		let workBytes: number | undefined;
		if(w){
			const handle=await fs.open(path.join(dir,file),'r');
			try{
				const hash=createHash('sha256');
				workBytes=0;
				for await(const piece of handle.createReadStream({autoClose:false})){
					const chunk=piece as Buffer;
					hash.update(chunk);workBytes+=chunk.length;
				}
				bytes+=workBytes;
				fingerprint=hash.digest('hex');
			}finally{await handle.close();}
		}
		changes.push({file,head:h,work:w,stage:s,fingerprint,workBytes});
	}
	const {identity}=await readRepositoryIdentity(dir);
	const signature=digest(JSON.stringify([branch,head,indexHash,changes,identity]));
	return {head,branch,signature,identity,staged:changes.some(c=>c.head!==c.stage),changes,files:matrix.length,bytes,elapsed:Date.now()-start,platform:process.platform};
}

export interface SaveRecord {
	head:string; branch:string; message:string; candidate?:string; committed?:string; staged:string[]; problem?:string;
}
export type CommitMode = 'smart' | 'staged' | 'amend';
export async function saveVersion(dir: string, confirmed: VersionPreview, message: string, record?:(value:SaveRecord)=>Promise<void>, mode:CommitMode='smart', selected?:ReadonlySet<string>) {
	if(!message.trim())throw new Error(tr('请填写提交说明','Enter a commit message.'));
	const branch=await guardGit(dir);
	if(branch!==confirmed.branch)throw new Error(tr('当前分支已变化','The current branch changed'));
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
		if(fresh.signature!==confirmed.signature)throw new Error(tr('提交身份、HEAD、索引或工作区已变化，请重新预览','Commit identity, HEAD, index or worktree changed. Preview again.'));
		const author=requireIdentity(fresh.identity);
		if(!fresh.changes.length)throw new Error(tr('没有可提交的变更','No changes to commit'));
		if(mode!=='smart' && !fresh.staged)throw new Error(tr('请先暂存要提交的内容','Stage changes first'));
		if(mode==='amend' && !fresh.head)throw new Error(tr('没有可修订的提交','No commit to amend'));
		const items=selected?fresh.changes.filter(c=>selected.has(c.file)):fresh.changes;
		if(selected && (fresh.staged || mode!=='smart' || !items.length || items.length!==selected.size))
			throw new Error(tr('自动提交清单已变化或索引已有暂存','Automatic selection changed or the index already contains staged changes.'));
		await record?.(receipt);
		if(!fresh.staged)for(const change of items){
			if(change.work){
				const bytes=await fs.readFile(path.join(dir,change.file));
				if(digest(bytes)!==change.fingerprint)throw new Error(tr('文件已变化：','File changed: ')+change.file);
				await git.add({...repo,filepath:change.file});
				expectedBlobs.set(change.file,(await git.hashBlob({object:bytes})).oid);
			}else{
				if(await statIfPresent(path.join(dir,change.file)))throw new Error(tr('文件已恢复：','File restored: ')+change.file);
				await git.remove({...repo,filepath:change.file});
			}
			done.push(change.file);
		}
		if(expectedBlobs.size){
			await git.walk({...repo,trees:[git.STAGE()],map:async(file,[entry])=>{
				if(expectedBlobs.has(file)){
					if(!entry || await entry.oid()!==expectedBlobs.get(file))throw new Error(tr('暂存内容已变化：','Staged content changed: ')+file);
					expectedBlobs.delete(file);
				}
			}});
			if(expectedBlobs.size)throw new Error(tr('预览的文件未全部暂存','Some previewed files were not staged'));
		}
		const timestamp=Math.floor(Date.now()/1000);
		const identity={...author,timestamp,timezoneOffset:new Date().getTimezoneOffset()};
		const originalAuthor=mode==='amend' ? (await git.readCommit({...repo,oid:fresh.head})).commit.author : identity;
		const args={...repo,message:message.trim(),author:originalAuthor,committer:identity,amend:mode==='amend',disallowEmpty:true};
		receipt.candidate=await git.commit({...args,noUpdateBranch:true});
		await record?.(receipt);
		const oid=await git.commit(args);
		receipt.committed=oid;
		await record?.(receipt);
		return oid;
	} catch(error){
		receipt.problem=String(error);
		await record?.(receipt);
		throw new Error(String(error)+tr('；本次已暂存：','. Staged during this operation: ')+(done.join(', ') || tr('无','none'))+tr('。请重新查看 HEAD 和暂存区。','. Review HEAD and the index again.'));
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
