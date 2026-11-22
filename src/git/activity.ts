import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { statIfPresent } from '../fs/paths.ts';

/** Observe Git metadata without a worktree walk or a Git process. */
export async function repositoryActivity(dir:string):Promise<string>{
	const git=join(dir,'.git');
	if(!(await statIfPresent(git))?.isDirectory())return '';
	async function entry(relative:string,walk=false):Promise<unknown>{
		const target=join(git,relative),state=await statIfPresent(target);
		if(!state)return null;
		const stamp=[relative,state.ino,state.mode,state.size,state.ctimeMs,state.mtimeMs];
		if(!walk || !state.isDirectory())return stamp;
		const names=await readdir(target).catch((error:unknown)=>{
			if((error as NodeJS.ErrnoException).code==='ENOENT')return [];
			throw error;
		});
		return [stamp,await Promise.all(names.sort().map(name=>entry(relative+'/'+name,true)))];
	}
	const metadata=['HEAD','index','packed-refs','config','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply'];
	return JSON.stringify(await Promise.all([...metadata.map(name=>entry(name)),entry('refs',true)]));
}
