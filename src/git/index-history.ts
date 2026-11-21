import {fromEnglish} from '../i18n.ts';
import {guardGit} from './guard.ts';
import {gitResult} from './network-native.ts';
import {fields,readCommit} from './repository.ts';

interface FileDelta {file:string;before?:string;after?:string}

export async function commitFiles(dir:string,oid:string){
	await guardGit(dir,new Set(),true);
	const {commit}=await readCommit(dir,oid),parent=commit.parent[0];
	const args=['diff-tree','--no-commit-id','--no-renames','--no-abbrev','--raw','-r','-z',...(parent?[parent,oid]:['--root',oid])];
	const tokens=fields((await gitResult(dir,args)).stdout),files:FileDelta[]=[];
	for(let i=0;i<tokens.length;i+=2){
		const entry=tokens[i],file=tokens[i+1];
		if(!entry || !file)throw new Error('Incomplete Git tree change');
		const match=/^:(\d+) (\d+) ([a-f0-9]{40}) ([a-f0-9]{40}) [ADMT]$/u.exec(entry);
		if(!match)throw new Error('Invalid Git tree change');
		const before=match[1]!.startsWith('100')?match[3]:undefined,after=match[2]!.startsWith('100')?match[4]:undefined;
		if(before || after)files.push({file,before,after});
	}
	return {parent,files};
}

export async function committedComparison(dir:string,oid:string,file:string){
	const {parent,files}=await commitFiles(dir,oid),item=files.find(c=>c.file===file);
	if(!item)throw new Error(fromEnglish('File not found in commit changes.','在本次提交的变更中找不到文件。'));
	const blob=async(id?:string)=>id?(await gitResult(dir,['cat-file','blob',id])).stdout:undefined;
	return {parent,before:await blob(item.before),after:await blob(item.after)};
}

export async function conflictFiles(dir:string){
	await guardGit(dir,new Set(),true);
	const rows=fields((await gitResult(dir,['ls-files','-u','-z'])).stdout);
	return [...new Set(rows.map(r=>r.slice(r.indexOf('\t')+1)))];
}
