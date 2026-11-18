import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { statIfPresent } from '../fs/vault.ts';

// Only self-contained repositories and ordinary stage-zero index entries are writable.
export function verifyIndex(index: Buffer): void {
	if (index.toString('ascii',0,4)!=='DIRC' || index.readUInt32BE(4)!==2) throw new Error('Unsupported Git index format');
	let offset=12;
	for(let i=0;i<index.readUInt32BE(8);i++){
		const mode=index.readUInt32BE(offset+24);
		const flags=index.readUInt16BE(offset+60);
		if ((flags & 0xf000) || ![0o100644,0o100755].includes(mode)) throw new Error('Special or conflicted Git index entry');
		const end=index.indexOf(0,offset+62);
		if(end<0 || end>=index.length-20) throw new Error('Invalid Git index');
		const name=index.toString('utf8',offset+62,end);
		if(name.includes('\\') || name.split('/').some(part=>!part || part==='.' || part==='..' || part.toLowerCase()==='.git') || path.win32.isAbsolute(name)){
			throw new Error('Unsafe Git index path');
		}
		offset+=Math.ceil((end-offset+1)/8)*8;
	}
	while(offset<index.length-20){
		const signature=index.toString('ascii',offset,offset+4);
		if(signature!=='TREE')throw new Error('Unsupported index extension: '+signature);
		offset+=8+index.readUInt32BE(offset+4);
	}
	if(offset!==index.length-20) throw new Error('Invalid Git index size');
}

export async function guardGit(dir: string, ownLocks: ReadonlySet<string> = new Set(), historyOnly = false) {
	const gitdir=path.join(dir,'.git');
	if(!(await statIfPresent(gitdir))?.isDirectory())throw new Error('需要独立的库内 .git 目录');
	for(const name of ['index.lock','HEAD.lock','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer',
		'commondir','gitdir','worktrees','objects/info/alternates','config.worktree','shallow','info/attributes']){
		if(!historyOnly && !ownLocks.has(path.join(gitdir,name)) && await statIfPresent(path.join(gitdir,name)))throw new Error('Git 写入受阻：'+name);
	}
	async function checkTree(root: string, metadata: boolean) {
		const dirs=[root];
		for(const parent of dirs)for(const entry of await fs.readdir(parent,{withFileTypes:true})){
			const name=entry.name.toLowerCase();
			if(!metadata && parent===root && name==='.git')continue;
			if(entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || (!metadata && ['.git','.gitattributes','.gitmodules'].includes(name)) ||
				(metadata && !historyOnly && name.endsWith('.lock') && !ownLocks.has(path.join(parent,entry.name))))throw new Error('特殊仓库路径：'+path.relative(dir,path.join(parent,entry.name)));
			if(entry.isDirectory())dirs.push(path.join(parent,entry.name));
		}
	}
	await checkTree(gitdir,true);
	if (!historyOnly) await checkTree(dir,false);
	const config=await fs.readFile(path.join(gitdir,'config'),'utf8');
	if(!historyOnly && /^\s*\[\s*(?:filter|include|includeif|extensions)\b|^\s*(?:worktree|attributesfile|sparsecheckout|bare\s*=\s*true|autocrlf\s*=\s*(?:true|input))\b/imu.test(config)){
		throw new Error('特殊 Git 配置，请用原有 Git 工作流保存版本');
	}
	const head=(await fs.readFile(path.join(gitdir,'HEAD'),'utf8')).trim();
	const branch=head.match(/^ref: refs\/heads\/(.+)$/u)?.[1];
	if(!branch || branch.includes('..') || branch.includes('\\') || branch.includes(':') || branch.split('/').some(p=>!p || p.startsWith('.')))throw new Error('不支持的 HEAD 或分支路径');
	const index=path.join(gitdir,'index');
	if(!historyOnly && await statIfPresent(index))verifyIndex(await fs.readFile(index));
	return branch;
}
