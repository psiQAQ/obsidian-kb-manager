import { assertPrivateManifestTree } from './manifest-privacy.ts';
import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitResult } from './network-native.ts';
import { applyPatch, structuredPatch, reversePatch } from 'diff';
import { digest, statIfPresent } from '../fs/vault.ts';
import { withIndex } from './index-transaction.ts';
import { previewVersion } from './versions.ts';
import { guardGit } from './guard.ts';
import type { Change, VersionPreview } from './versions.ts';

export type IndexAction = 'stage' | 'unstage';

export function candidates(preview: VersionPreview, action: IndexAction): Change[] {
	return preview.changes.filter(c => action === 'stage' ? c.work !== c.stage : c.head !== c.stage);
}

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

async function indexEntry(dir:string,file:string){
	const raw=(await gitResult(dir,['ls-files','--stage','-z','--',file])).stdout.toString('utf8');
	const match=/^(\d{6}) ([0-9a-f]{40}) 0\t/u.exec(raw);
	return match?{mode:match[1]!,oid:match[2]!}:undefined;
}

async function publishedPreview(dir:string,preview:VersionPreview,locks?:Set<string>){
	const fresh=await previewVersion(dir,locks);
	if(fresh.signature!==preview.signature)throw new Error(fromEnglish('HEAD, index or working files changed. Refresh the preview.','HEAD、索引或工作区已变化，请刷新预览。'));
	return fresh;
}

export async function changeIndex(dir:string,preview:VersionPreview,action:IndexAction,files:readonly string[]){
	await writeIndex(dir,preview,action,files);
}

async function writeIndex(dir:string,preview:VersionPreview,action:IndexAction,files:readonly string[],replacement?:Uint8Array){
	await publishedPreview(dir,preview);
	await withIndex(dir,async(indexFile,locks,publish)=>{
		const fresh=await publishedPreview(dir,preview,locks);
		const allowed=new Set(candidates(fresh,action).map(c=>c.file));
		if(!files.length || files.some(file=>!allowed.has(file)))throw new Error(fromEnglish('Select files from the current preview.','请选择当前预览中的文件。'));
		const stdin=Buffer.from([...new Set(files)].join('\0')+'\0');
		if(replacement){
			const file=files[0]!,entry=await indexEntry(dir,file);
			if(!entry)throw new Error(fromEnglish('Index entry changed','索引条目已变化'));
			const oid=(await gitResult(dir,['hash-object','-w','--stdin'],{stdin:replacement})).stdout.toString('ascii').trim();
			await gitResult(dir,['update-index','--add','--cacheinfo',entry.mode,oid,file],{indexFile});
		}else if(action==='stage'){
			await gitResult(dir,['add','-A','--pathspec-from-file=-','--pathspec-file-nul'],{indexFile,stdin});
		}else if(fresh.head){
			await gitResult(dir,['reset','--quiet','--pathspec-from-file=-','--pathspec-file-nul',fresh.head],{indexFile,stdin});
		}else{
			await gitResult(dir,['update-index','--force-remove','-z','--stdin'],{indexFile,stdin});
		}
		if(action==='stage' && files.includes('kb.toml')){
			const tree=(await gitResult(dir,['write-tree'],{indexFile})).stdout.toString().trim();
			await assertPrivateManifestTree(dir,tree);
		}
		await publishedPreview(dir,preview,locks);
		await publish();
	});
}

export async function fileComparison(dir:string,preview:VersionPreview,file:string,staged:boolean){
	const fresh=await publishedPreview(dir,preview);
	const change=candidates(fresh,staged?'unstage':'stage').find(c=>c.file===file);
	if(!change)throw new Error(fromEnglish('File is no longer in this comparison.','文件已不在当前差异清单中。'));
	const entry=await indexEntry(dir,file);
	const index=entry?(await gitResult(dir,['cat-file','blob',entry.oid])).stdout:undefined;
	if(staged){
		const before=change.head?(await gitResult(dir,['cat-file','blob',fresh.head+':'+file])).stdout:undefined;
		return {before,after:index};
	}
	const work=change.work?await fs.readFile(path.join(dir,file)):undefined;
	if(work && digest(work)!==change.fingerprint)throw new Error(fromEnglish('File changed: ','文件已变化：')+file);
	return {before:index,after:work};
}

export async function editorIndexBase(dir:string,file:string){
	await verifyWorkingFile(dir,file);
	await guardGit(dir);
	const entry=await indexEntry(dir,file);
	if(entry)return (await gitResult(dir,['cat-file','blob',entry.oid])).stdout;
	const check=await gitResult(dir,['check-ignore','--quiet','--',file],{allowedExitCodes:[0,1]});
	return check.code===0?undefined:new Uint8Array();
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
