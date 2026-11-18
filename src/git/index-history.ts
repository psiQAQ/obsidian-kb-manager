import { fromEnglish } from '../i18n.ts';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import git from 'isomorphic-git';
import { guardGit } from './guard.ts';
import { repository } from './repository.ts';
import { statIfPresent } from '../fs/vault.ts';

interface FileDelta {file:string; before?:string; after?:string}
const emptyTree='4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function commitFiles(dir:string,oid:string) {
	await guardGit(dir,new Set(),true);
	if(!/^[a-f0-9]{40}$/u.test(oid)) throw new Error(fromEnglish('Invalid commit ID','提交 ID 无效'));
	const repo=repository(dir);
	const {commit}=await git.readCommit({...repo,oid});
	const parent=commit.parent[0];
	const files:FileDelta[]=[];
	await git.walk({...repo,trees:[git.TREE({ref:parent ?? emptyTree}),git.TREE({ref:oid})],map:async(file,[left,right])=>{
		const before=await left?.oid(), after=await right?.oid();
		const leftMode=await left?.mode(), rightMode=await right?.mode();
		if(before===after && leftMode===rightMode)return null;
		const a=await left?.type()==='blob' ? before : undefined;
		const b=await right?.type()==='blob' ? after : undefined;
		if(a || b)files.push({file,before:a,after:b});
		return undefined;
	}});
	return {parent,files:files.sort((a,b)=>a.file.localeCompare(b.file))};
}

export async function committedComparison(dir:string,oid:string,file:string){
	const {parent,files}=await commitFiles(dir,oid);
	const item=files.find(change=>change.file===file);
	if(!item)throw new Error(fromEnglish('File not found in commit changes.','在本次提交的变更中找不到文件。'));
	const repo=repository(dir);
	const read=async(blob?:string)=>blob ? (await git.readBlob({...repo,oid:blob})).blob : undefined;
	return {parent,before:await read(item.before),after:await read(item.after)};
}

// Only display names and stage numbers; never deserialize a conflicted index into a writer.
export async function conflictFiles(dir:string){
	await guardGit(dir,new Set(),true);
	const file=path.join(dir,'.git','index');
	if(!await statIfPresent(file))return [];
	const index=await fs.readFile(file);
	if(index.length<32 || index.toString('ascii',0,4)!=='DIRC' || index.readUInt32BE(4)!==2)return [];
	const conflicts=new Set<string>();
	let offset=12;
	for(let i=0;i<index.readUInt32BE(8);i++){
		if(offset+62>=index.length-20)throw new Error(fromEnglish('Invalid index entry','Git 索引条目无效'));
		const flags=index.readUInt16BE(offset+60);
		const end=index.indexOf(0,offset+62);
		if(end<0 || end>=index.length-20)throw new Error(fromEnglish('Invalid index path','Git 索引路径无效'));
		if(flags & 0x3000)conflicts.add(index.toString('utf8',offset+62,end));
		offset+=Math.ceil((end-offset+1)/8)*8;
	}
	return [...conflicts];
}
