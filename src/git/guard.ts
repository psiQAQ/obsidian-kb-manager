import {attributesPath,attributePolicies} from './markdown-attributes.ts';
import { tr, fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { statIfPresent } from '../fs/vault.ts';

function safeRef(ref:string) {
	return ref.startsWith('refs/') && !ref.includes('..') && !ref.includes('@{') &&
		!/[\\:~^?*[\s]/u.test(ref) && ref.split('/').every(p=>p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));
}

async function checkRefContents(file:string,packed:boolean) {
	const invalid=()=>new Error(fromEnglish('Invalid local Git reference: ','库内 Git 引用无效：')+path.basename(file));
	if(!packed && (await fs.stat(file)).size>8192)throw invalid();
	const value=(await fs.readFile(file,'utf8')).trimEnd();
	if(!packed){
		if(!/^[0-9a-f]{40}$/u.test(value) && !(value.startsWith('ref: ') && safeRef(value.slice(5))))throw invalid();
		return;
	}
	for(const line of value.split(/\r?\n/u)){
		if(!line || line.startsWith('#') || /^\^[0-9a-f]{40}$/u.test(line))continue;
		const fields=line.match(/^([0-9a-f]{40}) (.+)$/u);
		if(!fields || !safeRef(fields[2]!))throw invalid();
	}
}

// Only self-contained repositories and ordinary stage-zero index entries are writable.
export function verifyIndex(index: Buffer, merging:boolean|'resolved'=false): void {
	if (index.toString('ascii',0,4)!=='DIRC' || index.readUInt32BE(4)!==2) throw new Error(fromEnglish('Unsupported Git index format','不支持此 Git 索引格式'));
	let offset=12;
	for(let i=0;i<index.readUInt32BE(8);i++){
		const mode=index.readUInt32BE(offset+24);
		const flags=index.readUInt16BE(offset+60);
		if ((flags & (merging===true ? 0xc000 : 0xf000)) || ![0o100644,0o100755].includes(mode)) throw new Error(fromEnglish('Special or conflicted Git index entry','Git 索引含特殊条目或未解决冲突'));
		const end=index.indexOf(0,offset+62);
		if(end<0 || end>=index.length-20) throw new Error(fromEnglish('Invalid Git index','Git 索引无效'));
		const name=index.toString('utf8',offset+62,end);
		if(name.includes('\\') || name.split('/').some(part=>!part || part==='.' || part==='..' || part.toLowerCase()==='.git') || path.win32.isAbsolute(name)){
			throw new Error(fromEnglish('Unsafe Git index path','Git 索引路径不安全'));
		}
		offset+=Math.ceil((end-offset+1)/8)*8;
	}
	while(offset<index.length-20){
		const signature=index.toString('ascii',offset,offset+4);
		if(signature!=='TREE' && !(merging && signature==='REUC'))throw new Error(fromEnglish('Unsupported index extension: ','不支持的索引扩展：')+signature);
		offset+=8+index.readUInt32BE(offset+4);
	}
	if(offset!==index.length-20) throw new Error(fromEnglish('Invalid Git index size','Git 索引大小无效'));
}

export async function guardGit(dir: string, ownLocks: ReadonlySet<string> = new Set(), historyOnly = false, merging:boolean|'resolved'=false) {
	const gitdir=path.join(dir,'.git');
	if(!(await statIfPresent(gitdir))?.isDirectory())throw new Error(tr('需要独立的库内 .git 目录','A standalone .git directory is required in this library'));
	for(const name of ['index.lock','HEAD.lock','MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer',
		'commondir','gitdir','worktrees','objects/info/alternates','config.worktree','shallow','info/attributes']){
		if(merging===true && name==='MERGE_HEAD')continue;
		if(!historyOnly && !ownLocks.has(path.join(gitdir,name)) && await statIfPresent(path.join(gitdir,name)))throw new Error(tr('Git 写入受阻：','Git write blocked by: ')+name);
	}
	async function checkTree(root: string, metadata: boolean) {
		const dirs=[root];
		for(const parent of dirs)for(const entry of await fs.readdir(parent,{withFileTypes:true})){
			const name=entry.name.toLowerCase();
			if(!metadata && parent===root && name==='.git')continue;
			if(!metadata && parent===root && entry.name===attributesPath && entry.isFile()){
				const file=path.join(parent,entry.name),stat=await fs.lstat(file);
				if(stat.nlink===1 && attributePolicies.some(policy=>policy.length===stat.size) && attributePolicies.includes(await fs.readFile(file,'utf8')))continue;
			}
			if(entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || (!metadata && ['.git','.gitattributes','.gitmodules'].includes(name)) ||
				(metadata && !historyOnly && name.endsWith('.lock') && !ownLocks.has(path.join(parent,entry.name))))throw new Error(tr('特殊仓库路径：','Unsupported repository path: ')+path.relative(dir,path.join(parent,entry.name)));
			if(entry.isDirectory())dirs.push(path.join(parent,entry.name));
			else if(metadata && !name.endsWith('.lock')){
				const file=path.join(parent,entry.name);
				const relative=path.relative(gitdir,file).split(path.sep).join('/');
				const immutable=/^objects\/(?:[0-9a-f]{2}\/[0-9a-f]{38}|pack\/pack-[0-9a-f]{40}\.(?:pack|idx|rev))$/u.test(relative);
				if(!historyOnly && !immutable && (await fs.lstat(file)).nlink!==1)
					throw new Error(fromEnglish('Linked Git metadata: ','Git 元数据含外部硬链接：')+relative);
				if(file.startsWith(path.join(gitdir,'refs')+path.sep))await checkRefContents(file,false);
				else if(parent===gitdir && entry.name==='packed-refs')await checkRefContents(file,true);
			}
		}
	}
	await checkTree(gitdir,true);
	if (!historyOnly) await checkTree(dir,false);
	const config=await fs.readFile(path.join(gitdir,'config'),'utf8');
	if(!historyOnly && /^\s*\[\s*(?:filter|include|includeif|extensions)\b|^\s*(?:worktree|attributesfile|sparsecheckout|bare\s*=\s*true|autocrlf\s*=\s*(?:true|input))\b/imu.test(config)){
		throw new Error(tr('特殊 Git 配置，请用原有 Git 工作流保存版本','Unsupported Git configuration. Use the existing Git workflow to commit.'));
	}
	const head=(await fs.readFile(path.join(gitdir,'HEAD'),'utf8')).trim();
	const branch=head.match(/^ref: refs\/heads\/(.+)$/u)?.[1];
	if(!branch || !safeRef('refs/heads/'+branch))throw new Error(tr('不支持的 HEAD 或分支路径','Unsupported HEAD or branch path'));
	const index=path.join(gitdir,'index');
	if(!historyOnly && await statIfPresent(index))verifyIndex(await fs.readFile(index),merging);
	if(merging===true && !/^[0-9a-f]{40}$/u.test((await fs.readFile(path.join(gitdir,'MERGE_HEAD'),'utf8')).trim()))
		throw new Error(tr('仅支持双亲合并','Only two-parent merges are supported'));
	return branch;
}
