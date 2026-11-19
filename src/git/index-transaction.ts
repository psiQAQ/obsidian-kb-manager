import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { statIfPresent } from '../fs/vault.ts';
import { tr } from '../i18n.ts';

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
		const candidate=join(temporary,'index'),old=await statIfPresent(index);
		if(old){await fs.copyFile(index,candidate);await handle.chmod(old.mode&0o777);}
		return await action(candidate,new Set([lockPath]),async()=>{
			await handle.writeFile(await fs.readFile(candidate));await handle.sync();await handle.close();
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
