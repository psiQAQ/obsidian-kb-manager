import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import git from 'isomorphic-git';
import {digest,statIfPresent} from '../fs/vault.ts';
import {repository} from './repository.ts';
import {checkedNative} from './network-native.ts';
import {tr} from '../i18n.ts';
import {readRepositoryIdentity,requireIdentity} from './identity.ts';
import type {GitIdentity} from './identity.ts';

interface Stage {stage:number; oid:string; mode:string}
export interface MergePlan {
	head:string; other:string; branch:string; index:string; identity:GitIdentity;
	conflicts:{file:string;work:string|null;stages:Stage[]}[];
	stagedPaths:string[];
}

export async function inspectMerge(dir:string):Promise<MergePlan> {
	const run=await checkedNative(dir,true);
	const repo=repository(dir);
	const branch=(await run(['symbolic-ref','--short','HEAD'])).trim();
	const head=(await run(['rev-parse','HEAD'])).trim();
	const other=(await fs.readFile(path.join(repo.gitdir,'MERGE_HEAD'),'utf8')).trim();
	const index=digest(await fs.readFile(path.join(repo.gitdir,'index')));
	const groups=new Map<string,Stage[]>();
	for(const row of (await run(['ls-files','--unmerged','-z'])).split('\0').filter(Boolean)){
		const match=/^(100644|100755) ([a-f0-9]{40}) ([123])\t([\s\S]+)$/u.exec(row);
		if(!match)throw new Error(tr('冲突条目不受支持','Unsupported conflict entry'));
		const file=match[4]!;
		const stages=groups.get(file)??[];
		stages.push({mode:match[1]!,oid:match[2]!,stage:Number(match[3])});
		groups.set(file,stages);
	}
	const conflicts=[];
	for(const [file,stages] of groups){
		const location=path.join(dir,file),stat=await statIfPresent(location);
		if(stat && !stat.isFile())throw new Error(tr('冲突文件必须是普通文件','Expected a regular file at the conflicted path'));
		conflicts.push({file,work:stat?digest(await fs.readFile(location)):null,stages});
	}
	const stagedPaths=(await run(['diff','--cached','--no-ext-diff','--name-only','-z','HEAD','--'])).split('\0').filter(Boolean);
	const {identity}=await readRepositoryIdentity(dir);
	return {head,other,branch,index,conflicts,stagedPaths,identity};
}

async function stillMerging(dir:string,plan:MergePlan) {
	if(JSON.stringify(await inspectMerge(dir))!==JSON.stringify(plan))throw new Error(tr('合并状态或冲突文件已变化，请重新预览','Merge state or conflict contents changed. Preview again.'));
	return checkedNative(dir,true);
}
export async function markResolved(dir:string,plan:MergePlan,file:string) {
	const run=await stillMerging(dir,plan);
	const entry=plan.conflicts.find(c=>c.file===file);
	if(!entry || file==='kb-manager.json')throw new Error(tr('请检查库身份和冲突文件','Review the library identity and conflict path'));
	if(entry.work===null){
		await run(['update-index','--force-remove','--',file]);return;
	}
	const bytes=await fs.readFile(path.join(dir,file));
	if(digest(bytes)!==entry.work)throw new Error(tr('文件已变化','File changed'));
	const oid=await git.writeBlob({...repository(dir),blob:bytes});
	let mode=entry.stages.find(s=>s.stage===2)?.mode??entry.stages[entry.stages.length-1]!.mode;
	if(process.platform!=='win32')mode=(await fs.stat(path.join(dir,file))).mode&0o111?'100755':'100644';
	await run(['update-index','--add','--cacheinfo',mode,oid,file]);
}

export async function finishMerge(dir:string,plan:MergePlan,message:string) {
	if(plan.conflicts.length || !message.trim())throw new Error(tr('请先解决所有冲突，并填写合并说明','Resolve conflicts and enter a merge message.'));
	const run=await stillMerging(dir,plan);
	const identity=requireIdentity(plan.identity);
	if(plan.stagedPaths.includes('kb-manager.json'))throw new Error(tr('合并将改变库身份，请在外部核对','The merge would change the library identity. Review externally.'));
	await run(['-c','user.name='+identity.name,'-c','user.email='+identity.email,'commit','--no-verify','--no-gpg-sign','-m',message]);
	return (await run(['rev-parse','HEAD'])).trim();
}

export async function undoInfo(dir:string){
	const run=await checkedNative(dir,'resolved');
	const index=digest(await fs.readFile(path.join(dir,'.git','index')));
	const entries=(await run(['ls-files','--resolve-undo','-z'])).split('\0').filter(Boolean);
	return {index,entries};
}

export async function clearUndo(dir:string,preview:Awaited<ReturnType<typeof undoInfo>>){
	if(!preview.entries.length || JSON.stringify(await undoInfo(dir))!==JSON.stringify(preview))
		throw new Error(tr('索引已变化，请重新预览','Index changed. Preview again.'));
	const run=await checkedNative(dir,'resolved');
	await run(['update-index','--clear-resolve-undo']);
}
