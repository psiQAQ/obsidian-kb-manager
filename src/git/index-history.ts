import {fromEnglish} from '../i18n.ts';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {statIfPresent} from '../fs/paths.ts';
import {guardGit} from './guard.ts';
import {gitResult} from './network-native.ts';
import {fields,headOid,readCommit} from './repository.ts';

export type HistorySide = {kind:'commit';oid:string}|{kind:'empty'}|{kind:'working'};
type CommittedSide = Exclude<HistorySide,{kind:'working'}>;
type ChangeStatus = 'A'|'D'|'M'|'R'|'C'|'T';
type FileVersion = {file:string;mode:string;oid:string};
export interface HistoryFile {
	file:string;
	status:ChangeStatus;
	before?:FileVersion;
	after?:FileVersion;
	rewritten?:boolean;
}

const emptyTree='4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const historyTextLimit=2*1024*1024;
const oidPattern=/^[a-f0-9]{40}$/u;
const isRegular=(mode:string)=>mode==='100644' || mode==='100755';

export function isHistorySide(value:unknown):value is HistorySide {
	return !!value && typeof value==='object' && 'kind' in value && (value.kind==='empty' || value.kind==='working' ||
		(value.kind==='commit' && 'oid' in value && typeof value.oid==='string' && oidPattern.test(value.oid)));
}

function requireFile(file:string) {
	if(/[\\:\0]/u.test(file) || file.split('/').some(part=>!part || part==='.' || part==='..' || part.toLowerCase()==='.git'))
		throw new Error(fromEnglish('Invalid history file path.','无效的历史文件路径。'));
}

function* diffRecords(raw:Buffer):Generator<HistoryFile|string> {
	const tokens=fields(raw);
	for(let i=0;i<tokens.length;){
		const entry=tokens[i++]!;
		if(oidPattern.test(entry)){yield entry;continue;}
		const oldFile=tokens[i++];
		if(!oldFile)throw new Error('Incomplete Git tree change');
		const match=/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ACDMRT])(\d*)$/u.exec(entry);
		if(!match)throw new Error('Invalid Git tree change');
		const [,oldMode,newMode,oldOid,newOid]=match;
		const status=match[5]! as ChangeStatus;
		const file=status==='R' || status==='C'?tokens[i++]:oldFile;
		if(!file)throw new Error('Incomplete Git rename');
		requireFile(oldFile);
		if(file!==oldFile)requireFile(file);
		const before=isRegular(oldMode!)?{file:oldFile,oid:oldOid!,mode:oldMode}:undefined;
		const after=isRegular(newMode!)?{file,oid:newOid!,mode:newMode}:undefined;
		if(before || after)yield {file,status:!before?'A':!after?'D':status,before,after,
			...(status==='M' && match[6]?{rewritten:true}:{})};
	}
}

function parseDeltas(raw:Buffer) {
	const files:HistoryFile[]=[];
	for(const record of diffRecords(raw)){
		if(typeof record==='string')throw new Error('Unexpected Git diff header');
		files.push(record);
	}
	return files;
}

async function readWorkingFile<T>(dir:string,file:string,read:(handle:fs.FileHandle,stat:Stats)=>Promise<T>) {
	requireFile(file);
	const parts=file.split('/');
	let target=dir;
	for(const part of parts.slice(0,-1)){
		target=path.join(target,part);
		const stat=await statIfPresent(target);
		if(stat?.isSymbolicLink())throw new Error(fromEnglish('Linked history file: ','历史文件路径含链接：')+file);
		if(!stat?.isDirectory())return undefined;
	}
	target=path.join(target,parts.at(-1)!);
	const previous=await statIfPresent(target);
	if(!previous || previous.isDirectory())return undefined;
	if(!previous.isFile() || previous.nlink!==1)throw new Error(fromEnglish('Linked or unsupported history file: ','历史文件含链接或属于不受支持的类型：')+file);
	const handle=await fs.open(target,'r');
	const changed=()=>new Error(fromEnglish('Working file changed. Refresh the comparison.','工作区文件已变化，请刷新比较。')+' '+file);
	try{
		const initial=await handle.stat();
		if(initial.dev!==previous.dev || initial.ino!==previous.ino || initial.nlink!==1 || !initial.isFile())throw changed();
		const result=await read(handle,initial),final=await handle.stat();
		if(final.size!==initial.size || final.mtimeMs!==initial.mtimeMs || final.ctimeMs!==initial.ctimeMs)throw changed();
		return result;
	}finally{await handle.close();}
}

async function workingVersion(dir:string,entry:FileVersion,normalize=false) {
	if(normalize){
		const content=await historyContent(dir,{kind:'working'},entry.file);
		if(!content)return undefined;
		if(content.bytes){
			const {stdout}=await gitResult(dir,['hash-object','--stdin','--path='+entry.file],{stdin:content.bytes});
			return {...entry,oid:stdout.toString('ascii').trim()};
		}
	}
	return readWorkingFile(dir,entry.file,async(handle,stat)=>{
		const hash=createHash('sha1').update(`blob ${stat.size}\0`);
		for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk as Buffer);
		return {...entry,oid:hash.digest('hex')};
	});
}

const options=['--raw','--no-abbrev','--no-ext-diff','--no-textconv','--find-renames','-z'];
const treeish=(side:CommittedSide)=>side.kind==='commit'?side.oid:emptyTree;

async function workingDeltas(dir:string,before:CommittedSide,followUntrackedRenames=true) {
	const [raw,untracked]=await Promise.all([
		gitResult(dir,['diff',...options,treeish(before),'--']),
		gitResult(dir,['ls-files','--others','--exclude-standard','-z']),
	]);
	const extras=new Set(fields(untracked.stdout));
	const files=new Map<string,HistoryFile>();
	for(const delta of parseDeltas(raw.stdout)){
		if(delta.status==='R' && delta.before && extras.has(delta.before.file)){
			const file=delta.before.file;
			files.set(file,{file,status:'D',before:delta.before});
			files.set(delta.file,{...delta,status:'A',before:undefined});
		}else files.set(delta.file,delta);
	}
	for(const file of extras){
		requireFile(file);
		const before=files.get(file)?.before;
		files.set(file,{file,status:before?'M':'A',before,after:{file,mode:'100644',oid:''}});
	}
	if(!followUntrackedRenames)return [...files.values()];
	const deleted=new Map<string,HistoryFile[]>();
	for(const delta of files.values()){
		if(delta.status!=='D' || !delta.before)continue;
		const matches=deleted.get(delta.before.oid)??[];
		matches.push(delta);deleted.set(delta.before.oid,matches);
	}
	// Git already pairs tracked renames. An untracked destination is absent from its diff.
	for(const file of extras){
		const delta=files.get(file);
		if(!delta?.after || (!delta.before && !deleted.size))continue;
		const content=await workingVersion(dir,delta.after);
		if(!content)throw new Error(fromEnglish('Working files changed. Refresh the comparison.','工作区文件已变化，请刷新比较。'));
		if(delta.before){
			if(delta.before.oid===content.oid && delta.before.mode===content.mode)files.delete(file);
			continue;
		}
		const matches=deleted.get(content.oid);
		const source=matches?.shift();
		if(matches && source){
			if(!matches.length)deleted.delete(content.oid);
			files.delete(source.file);
			delta.status='R';delta.before=source.before;
		}
	}
	return [...files.values()];
}

function reverseDelta(delta:HistoryFile):HistoryFile {
	const {before,after,status}=delta;
	return {file:before?.file??delta.file,before:after,after:before,status:status==='A'?'D':status==='D'?'A':status};
}

async function requireCommitSide(dir:string,side:HistorySide) {
	if(!isHistorySide(side))throw new Error('Invalid history comparison side');
	if(side.kind==='commit' && (await gitResult(dir,['cat-file','-t',side.oid])).stdout.toString().trim()!=='commit')
		throw new Error(fromEnglish('Expected a Git commit.','预期 Git 提交。'));
}

export async function compareHistory(dir:string,before:HistorySide,after:HistorySide):Promise<HistoryFile[]> {
	const working=before.kind==='working' || after.kind==='working';
	await guardGit(dir,new Set(),!working);
	await Promise.all([requireCommitSide(dir,before),requireCommitSide(dir,after)]);
	let files:HistoryFile[];
	if(before.kind==='working')files=after.kind==='working'?[]:(await workingDeltas(dir,after)).map(reverseDelta);
	else if(after.kind==='working')files=await workingDeltas(dir,before);
	else files=parseDeltas((await gitResult(dir,['diff-tree','--no-commit-id','-r',...options,treeish(before),treeish(after),'--'])).stdout);
	return files.sort((a,b)=>Buffer.compare(Buffer.from(a.file),Buffer.from(b.file)));
}

interface FileContent {bytes?:Buffer;size:number}
async function blobContent(dir:string,oid:string):Promise<FileContent> {
	const size=Number((await gitResult(dir,['cat-file','-s',oid])).stdout.toString().trim());
	return {size,bytes:size<=historyTextLimit?(await gitResult(dir,['cat-file','blob',oid])).stdout:undefined};
}

async function treeFile(dir:string,oid:string,file:string) {
	const raw=fields((await gitResult(dir,['ls-tree','-z',oid,'--',file])).stdout)[0];
	const match=raw && /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(raw);
	return match && match[3]===file?{file,mode:match[1]!,oid:match[2]!}:undefined;
}

async function historyContent(dir:string,side:HistorySide,file:string):Promise<FileContent|undefined> {
	requireFile(file);
	if(side.kind==='empty')return undefined;
	if(side.kind==='working')return readWorkingFile(dir,file,async(handle,stat)=>{
		if(stat.size>historyTextLimit)return {size:stat.size};
		const bytes=Buffer.alloc(stat.size);
		let offset=0;
		while(offset<bytes.length){
			const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
			if(!bytesRead)throw new Error(fromEnglish('Working file changed. Refresh the comparison.','工作区文件已变化，请刷新比较。'));
			offset+=bytesRead;
		}
		return {size:stat.size,bytes};
	});
	const entry=await treeFile(dir,side.oid,file);
	return entry?blobContent(dir,entry.oid):undefined;
}

interface CommitEdge {child:string;parent:string}

async function commitChanges(dir:string,edges:readonly CommitEdge[]) {
	const stdin=edges.map(({child,parent})=>child+' '+parent+'\n').join('');
	const {stdout}=await gitResult(dir,['diff-tree','--stdin','--always','-r','--break-rewrites',...options],{stdin});
	const batches:HistoryFile[][]=[];
	let current:HistoryFile[]|undefined;
	for(const record of diffRecords(stdout)){
		if(typeof record==='string'){
			if(record!==edges[batches.length]?.child)throw new Error('Unexpected Git diff header');
			current=[];batches.push(current);
		}else{
			if(!current)throw new Error('Missing Git diff header');
			current.push(record);
		}
	}
	if(batches.length!==edges.length)throw new Error('Incomplete Git diff batch');
	return batches;
}

async function replacesText(dir:string,before:FileVersion,after:FileVersion,working:boolean) {
	const [previous,next]=await Promise.all([blobContent(dir,before.oid),working
		?historyContent(dir,{kind:'working'},after.file):blobContent(dir,after.oid)]);
	if(!previous.bytes || !next?.bytes || previous.bytes.includes(0) || next.bytes.includes(0))return false;
	const lines=(bytes:Buffer)=>bytes.toString('utf8').split(/\r?\n/u).map(line=>line.trim()).filter(Boolean);
	const from=lines(previous.bytes),to=new Set(lines(next.bytes));
	return from.length>0 && !from.some(line=>to.has(line));
}

async function nextHistoryPath(dir:string,file:string,changes:readonly HistoryFile[],working=false) {
	const direct=changes.find(change=>change.status!=='C' && change.before?.file===file);
	if(!direct?.before)return file;
	const previous=direct.before.oid;
	if(direct.after?.file===file && direct.after.oid===previous)return file;
	const candidates=new Set(changes.flatMap(({status,before,after})=>after && after.file!==file &&
		((after.oid===previous && after.oid!==before?.oid) || (before?.file===file && (status==='R' || status==='C')))?[after.file]:[]));
	if(candidates.size===1){
		// If the old path was also edited, an exact copy can be a second note. Require evidence that the original text moved.
		if(direct.after?.file===file && !direct.rewritten && !await replacesText(dir,direct.before,direct.after,working))return undefined;
		return candidates.values().next().value;
	}
	if(candidates.size || direct.rewritten)return undefined;
	return direct.after?.file;
}

async function committedSuccessor(dir:string,oid:string,file:string,head:string) {
	const {stdout}=await gitResult(dir,['rev-list','--ancestry-path','--reverse','--topo-order','--parents',oid+'..'+head]);
	const paths=new Map([[oid,file]]);
	const edges:CommitEdge[]=[];
	const reachable=new Set([oid]);
	for(const line of stdout.toString('ascii').trim().split('\n').filter(Boolean)){
		const [child,...parents]=line.split(' ');
		if(!child || ![child,...parents].every(parent=>oidPattern.test(parent)))throw new Error('Invalid Git ancestry');
		for(const parent of parents.filter(parent=>reachable.has(parent)))edges.push({child,parent});
		reachable.add(child);
	}
	const size=32;
	for(let offset=0;offset<edges.length;offset+=size){
		const batch=edges.slice(offset,offset+size),changes=await commitChanges(dir,batch);
		for(const [i,{child,parent}] of batch.entries()){
			const prior=paths.get(parent),known=paths.get(child);
			const next=prior===undefined?undefined:await nextHistoryPath(dir,prior,changes[i]!);
			// Every retained ancestry path reaches HEAD. A deletion or a merge whose paths disagree stops tracking.
			if(next===undefined || (known!==undefined && known!==next))return undefined;
			paths.set(child,next);
		}
	}
	return paths.get(head);
}

export async function currentHistoryPath(dir:string,oid:string,file:string) {
	requireFile(file);
	await guardGit(dir,new Set(),false,false,'detached');
	await requireCommitSide(dir,{kind:'commit',oid});
	const head=await headOid(dir);
	if(!head || !await treeFile(dir,oid,file))return undefined;
	const tracked=oid===head?file:await committedSuccessor(dir,oid,file,head);
	if(!tracked)return undefined;
	const changes=await workingDeltas(dir,{kind:'commit',oid:head},false);
	const direct=changes.find(change=>change.before?.file===tracked && change.status!=='C');
	if(direct?.before){
		// Inspect possible working successors without allowing Git's pairing order to choose between exact matches.
		if(direct.after)direct.after=await workingVersion(dir,direct.after,true);
		if(direct.after?.file!==tracked || direct.after.oid!==direct.before.oid){
			for(const change of changes){
				if(!change.before && change.after)change.after=await workingVersion(dir,change.after,true);
			}
		}
	}
	const successor=await nextHistoryPath(dir,tracked,changes,true);
	if(successor && head===await headOid(dir) && await readWorkingFile(dir,successor,()=>Promise.resolve(true)))return successor;
	return undefined;
}

export async function compareHistoryFile(dir:string,before:HistorySide,after:HistorySide,file:string,oldFile=file) {
	await guardGit(dir,new Set(),before.kind!=='working' && after.kind!=='working');
	await Promise.all([requireCommitSide(dir,before),requireCommitSide(dir,after)]);
	const [left,right]=await Promise.all([historyContent(dir,before,oldFile),historyContent(dir,after,file)]);
	if(!left && !right)throw new Error(fromEnglish('File not found in this comparison.','在本次比较中找不到文件。'));
	return {before:left,after:right};
}

export async function readHistorySnapshot(dir:string,oid:string,file:string) {
	await guardGit(dir,new Set(),true);
	const side={kind:'commit',oid} as const;
	await requireCommitSide(dir,side);
	const content=await historyContent(dir,side,file);
	if(!content)throw new Error(fromEnglish('File not found in this commit.','在该提交中找不到文件。'));
	return content;
}

export async function commitFiles(dir:string,oid:string,selectedParent?:string){
	await guardGit(dir,new Set(),true);
	const {commit}=await readCommit(dir,oid),parent=selectedParent??commit.parent[0];
	if(selectedParent!==undefined && !commit.parent.includes(selectedParent))throw new Error(fromEnglish('Invalid comparison parent.','所选提交不是该提交的父提交。'));
	const raw=await gitResult(dir,['diff-tree','--no-commit-id','-r',...options,'--no-renames',parent??emptyTree,oid,'--']);
	const files=parseDeltas(raw.stdout).map(({file,before,after})=>({file,before:before?.oid,after:after?.oid}));
	return {parent,files};
}

export async function committedComparison(dir:string,oid:string,file:string,selectedParent?:string){
	const {parent,files}=await commitFiles(dir,oid,selectedParent),item=files.find(c=>c.file===file);
	if(!item)throw new Error(fromEnglish('File not found in commit changes.','在本次提交的变更中找不到文件。'));
	const [before,after]=await Promise.all([item.before?blobContent(dir,item.before):undefined,item.after?blobContent(dir,item.after):undefined]);
	return {parent,before:before?.bytes,after:after?.bytes,beforeSize:before?.size,afterSize:after?.size};
}

export async function conflictFiles(dir:string){
	await guardGit(dir,new Set(),true);
	const rows=fields((await gitResult(dir,['ls-files','-u','-z'])).stdout);
	return [...new Set(rows.map(r=>r.slice(r.indexOf('\t')+1)))];
}
