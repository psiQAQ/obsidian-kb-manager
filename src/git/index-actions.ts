import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import git from 'isomorphic-git';
import { applyPatch, structuredPatch, reversePatch } from 'diff';
import { digest, statIfPresent } from '../fs/vault.ts';
import { repository } from './repository.ts';
import { previewVersion } from './versions.ts';
import { guardGit } from './guard.ts';
import type { Change, VersionPreview } from './versions.ts';

export type IndexAction = 'stage' | 'unstage';

export function candidates(preview: VersionPreview, action: IndexAction): Change[] {
	return preview.changes.filter(c => action === 'stage' ? c.work !== c.stage : c.head !== c.stage);
}

interface BlobInfo { oid: string; mode: number }

export async function verifyWorkingFile(dir:string,file:string) {
	if(path.win32.isAbsolute(file) || /[\\:\0]/u.test(file) || file.split('/').some(p=>!p || p==='.' || p==='..' || p.toLowerCase()==='.git')){
		throw new Error(fromEnglish('Invalid worktree path','工作区路径无效'));
	}
	let target=dir;
	for(const part of file.split('/')){
		target=path.join(target,part);
		const stat=await statIfPresent(target);
		if(stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink!==1))throw new Error(fromEnglish('Linked worktree file: ','工作区文件有外部链接：')+file);
	}
}

async function objects(dir: string, tree: ReturnType<typeof git.STAGE>, names: readonly string[]) {
	const entries = new Map<string, BlobInfo>();
	const routes = new Set<string>(['.']);
	for (const file of names) {
		const parts = file.split('/');
		for (let i=1; i<=parts.length; i++) routes.add(parts.slice(0,i).join('/'));
	}
	await git.walk({...repository(dir), trees:[tree], map: async (file,[entry]) => {
		if (!entry || !routes.has(file)) return null;
		if (await entry.type() === 'blob') entries.set(file,{oid:await entry.oid(), mode:await entry.mode()});
		return undefined;
	}});
	return entries;
}

async function publishedPreview(dir: string, preview: VersionPreview, locks?: Set<string>) {
	const fresh = await previewVersion(dir,locks);
	if (fresh.signature !== preview.signature) throw new Error(fromEnglish('HEAD, index or working files changed. Refresh the preview.','HEAD、索引或工作区已变化，请刷新预览。'));
	return fresh;
}

// Prepare all edits against a private index and publish once under Git's index.lock.
// Interrupted batches never expose a partially updated index to another client.
export async function changeIndex(dir: string, preview: VersionPreview, action: IndexAction, files: readonly string[]) {
	await writeIndex(dir,preview,action,files);
}

async function writeIndex(dir: string, preview: VersionPreview, action: IndexAction, files: readonly string[], replacement?:Uint8Array) {
	const repo = repository(dir);
	await publishedPreview(dir,preview);
	const index = path.join(repo.gitdir,'index');
	const lockPath = index+'.lock';
	const lock = await fs.open(lockPath,'wx',0o600);
	const owned=await lock.stat({bigint:true});
	async function ownsLock(){
		const current=await fs.lstat(lockPath,{bigint:true}).catch((error:NodeJS.ErrnoException)=>{
			if(error.code==='ENOENT')return undefined;
			throw error;
		});
		return current?.dev===owned.dev && current.ino===owned.ino;
	}
	let shadow: string | undefined;
	let published = false;
	try {
		const fresh = await publishedPreview(dir,preview,new Set([lockPath]));
		const available = new Map(candidates(fresh,action).map(change => [change.file,change]));
		if (!files.length || files.some(file=>!available.has(file))) throw new Error(fromEnglish('Select files from the current preview.','请选择当前预览中的文件。'));
		shadow = await fs.mkdtemp(path.join(repo.gitdir,'kb-index-'));
		const shadowIndex = path.join(shadow,'index');
		const originalIndex = await statIfPresent(index);
		if (originalIndex) {
			await fs.copyFile(index,shadowIndex);
			await lock.chmod(originalIndex.mode & 0o777);
		}
		const originals = !replacement && action === 'unstage' && fresh.head
			? await objects(dir,git.TREE({ref:fresh.head}),files)
			: await objects(dir,git.STAGE(),files);
		for (const filepath of new Set(files)) {
			const change = available.get(filepath)!;
			let blob = action === 'unstage' && fresh.head ? originals.get(filepath) : undefined;
			if (replacement) {
				const indexed=originals.get(filepath);
				if(!indexed)throw new Error(fromEnglish('Index entry no longer exists.','索引条目已不存在。'));
				blob={oid:await git.writeBlob({...repo,blob:replacement}),mode:indexed.mode};
			} else if (action === 'stage' && change.work) {
				const location = path.join(dir,filepath);
				const stat = await fs.lstat(location);
				if (!stat.isFile()) throw new Error(fromEnglish('File type changed: ','文件类型已变化：')+filepath);
				const bytes = await fs.readFile(location);
				if (digest(bytes)!==change.fingerprint) throw new Error(fromEnglish('File changed: ','文件已变化：')+filepath);
				const mode = process.platform === 'win32' ? originals.get(filepath)?.mode ?? 0o100644
					: (stat.mode & 0o111 ? 0o100755 : 0o100644);
				blob = {oid:await git.writeBlob({...repo,blob:bytes}),mode};
			}
			await git.updateIndex({...repo,gitdir:shadow,filepath,...(blob ? {add:true,...blob} : {remove:true,force:true})});
		}
		await publishedPreview(dir,preview,new Set([lockPath]));
		await lock.writeFile(await fs.readFile(shadowIndex));
		await lock.sync();
		await lock.close();
		if(!await ownsLock())throw new Error(fromEnglish('Index lock changed. Refresh and retry.','索引锁已变化，请刷新并重试。'));
		await fs.rename(lockPath,index);
		published = true;
	} finally {
		try {
			if (!published) {
				await lock.close();
				if(await ownsLock())await fs.unlink(lockPath);
			}
		} finally {
			if (shadow) {
				await fs.rm(path.join(shadow,'index'),{force:true});
				await fs.rmdir(shadow);
			}
		}
	}
}

export async function fileComparison(dir: string, preview: VersionPreview, file: string, staged: boolean) {
	const fresh = await publishedPreview(dir,preview);
	const change = candidates(fresh,staged ? 'unstage' : 'stage').find(c=>c.file===file);
	if (!change) throw new Error(fromEnglish('File is no longer in this comparison.','文件已不在当前差异清单中。'));
	const repo = repository(dir);
	const indexed = (await objects(dir,git.STAGE(),[file])).get(file);
	const index = indexed ? (await git.readBlob({...repo,oid:indexed.oid})).blob : undefined;
	if (staged) {
		const head = change.head ? (await git.readBlob({...repo,oid:fresh.head,filepath:file})).blob : undefined;
		return {before:head,after:index};
	}
	const work = change.work ? await fs.readFile(path.join(dir,file)) : undefined;
	if (work && digest(work)!==change.fingerprint) throw new Error(fromEnglish('File changed: ','文件已变化：')+file);
	return {before:index,after:work};
}

export async function editorIndexBase(dir:string,file:string){
	await verifyWorkingFile(dir,file);
	await guardGit(dir);
	const repo=repository(dir);
	const indexed=(await objects(dir,git.STAGE(),[file])).get(file);
	if(!indexed && await git.isIgnored({...repo,filepath:file}))return undefined;
	return indexed ? (await git.readBlob({...repo,oid:indexed.oid})).blob : new Uint8Array();
}

export function textHunks(before:Uint8Array,after:Uint8Array,timeout=500) {
	if(before.length+after.length>2*1024*1024 || before.includes(0) || after.includes(0))throw new Error(fromEnglish('Hunks require a text file.','差异块功能需要文本文件。'));
	const decode=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
	const a=decode.decode(before), b=decode.decode(after);
	const patch=structuredPatch('index','file',a,b,undefined,undefined,{timeout,context:3});
	if(!patch)throw new Error(fromEnglish('Diff computation timed out.','差异计算超时。'));
	return {a,b,patch};
}

export function reverseWorkHunk(before:Uint8Array,after:Uint8Array,index:number,timeout=500){
	const {b,patch}=textHunks(before,after,timeout);
	const hunk=patch.hunks[index];
	if(!hunk)throw new Error(fromEnglish('Hunk changed. Refresh the diff.','差异块已变化，请刷新差异。'));
	const restored=applyPatch(b,reversePatch({...patch,hunks:[hunk]}),{autoConvertLineEndings:false});
	if(restored===false)throw new Error(fromEnglish('Hunk no longer applies.','当前差异块已无法应用。'));
	return restored;
}

export async function changeIndexHunk(dir:string,preview:VersionPreview,action:IndexAction,file:string,hunkIndex:number) {
	const {before,after}=await fileComparison(dir,preview,file,action==='unstage');
	if(!before || !after)throw new Error(fromEnglish('Use a whole-file action for additions and deletions.','对于新增或删除的文件，请操作整个文件。'));
	const {a,b,patch}=textHunks(before,after);
	const hunk=patch.hunks[hunkIndex];
	if(!hunk)throw new Error(fromEnglish('Hunk changed. Refresh the diff.','差异块已变化，请刷新差异。'));
	const selected={...patch,hunks:[hunk]};
	const next=action==='stage' ? applyPatch(a,selected,{autoConvertLineEndings:false})
		: applyPatch(b,reversePatch(selected),{autoConvertLineEndings:false});
	if(next===false)throw new Error(fromEnglish('Hunk no longer applies.','当前差异块已无法应用。'));
	await writeIndex(dir,preview,action,[file],new TextEncoder().encode(next));
}
