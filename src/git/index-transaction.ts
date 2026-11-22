import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { statIfPresent } from '../fs/vault.ts';
import { tr } from '../i18n.ts';

async function copyIndex(index:string,candidate:string){
	const old=await statIfPresent(index);
	if(!old)return;
	if(!old.isFile() || old.nlink!==1)throw new Error(tr('需要独立的 Git 索引文件','Expected an ordinary unlinked Git index'));
	await fs.copyFile(index,candidate);
	// Git uses the index mtime to decide when same-size worktree files need rehashing.
	// Round down so copying the index never advances that cutoff.
	await fs.utimes(candidate,old.atime,Math.floor(old.mtimeMs / 1000));
	return old;
}

/** Git can refresh stat data during diff. Keep that refresh outside the live index. */
export async function withIndexCopy<T>(dir:string,action:(indexFile:string)=>Promise<T>){
	const gitdir=join(dir,'.git'),temporary=await fs.mkdtemp(join(gitdir,'kb-index-view-'));
	const candidate=join(temporary,'index');
	try{
		await copyIndex(join(gitdir,'index'),candidate);
		return await action(candidate);
	}finally{
		await fs.rm(candidate,{force:true});
		await fs.rm(candidate+'.lock',{force:true});
		await fs.rmdir(temporary);
	}
}

// Git's index.lock reserves the real index. Git commands build a candidate in
// a separate file so a failed batch cannot partly overwrite staged changes.
export async function withIndex<T>(dir:string,action:(indexFile:string,locks:Set<string>,publish:()=>Promise<void>)=>Promise<T>){
	const gitdir=join(dir,'.git'),index=join(gitdir,'index'),lockPath=index+'.lock';
	const handle=await fs.open(lockPath,'wx',0o600),owned=await handle.stat({bigint:true});
	let temporary:string|undefined,published=false;
	const owns=async()=>{
		const current=await fs.lstat(lockPath,{bigint:true}).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
		return current && current.dev===owned.dev && current.ino===owned.ino;
	};
	try{
		temporary=await fs.mkdtemp(join(gitdir,'kb-index-'));
		const candidate=join(temporary,'index'),old=await copyIndex(index,candidate);
		if(old)await handle.chmod(old.mode&0o777);
		return await action(candidate,new Set([lockPath]),async()=>{
			const stat=await fs.stat(candidate);
			await handle.writeFile(await fs.readFile(candidate));
			await handle.utimes(stat.atime,Math.floor(stat.mtimeMs / 1000));
			await handle.sync();await handle.close();
			if(!await owns())throw new Error(tr('索引锁已变化，请重新预览','Index lock changed. Preview again.'));
			await fs.rename(lockPath,index);published=true;
		});
	}finally{
		await handle.close();
		if(!published && await owns())await fs.unlink(lockPath);
		if(temporary){
			await fs.rm(join(temporary,'index'),{force:true});
			await fs.rmdir(temporary);
		}
	}
}
