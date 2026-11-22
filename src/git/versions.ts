import { assertPrivateManifestTree } from './manifest-privacy.ts';
import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { digest,statIfPresent } from '../fs/vault.ts';
import { guardGit } from './guard.ts';
import { gitResult } from './network-native.ts';
import { fields,headOid,readCommit } from './repository.ts';
import { checkedIdentityArgs,readRepositoryIdentity } from './identity.ts';
import type { GitIdentity, IdentityValue } from './identity.ts';
import { withIndex,withIndexCopy } from './index-transaction.ts';

export interface Change {file:string;head:number;work:number;stage:number;fingerprint?:string;workBytes?:number}
export interface VersionPreview {
	head:string;branch:string;signature:string;identity:GitIdentity;staged:boolean;changes:Change[];
	identitySources:{name?:IdentityValue;email?:IdentityValue};
	files:number;bytes:number;elapsed:number;platform:string;
}

export async function previewVersion(dir:string,ownLocks:ReadonlySet<string>=new Set()):Promise<VersionPreview>{
	const start=Date.now(),branch=await guardGit(dir,ownLocks),index=path.join(dir,'.git','index');
	const [head,status,listed,who,indexHash]=await Promise.all([
		headOid(dir),gitResult(dir,['status','--porcelain=v1','-z','--no-renames','--untracked-files=all']),
		gitResult(dir,['ls-files','-z','--cached','--others','--exclude-standard']),readRepositoryIdentity(dir),
		statIfPresent(index).then(async s=>s?digest(await fs.readFile(index)):''),
	]);
	const files=new Map<string,Change>();
	const records=fields(status.stdout);
	// Porcelain can report a stat-only M after an editor saves a CRLF file as LF.
	// Ask Git for the actual index-to-worktree diff, keeping staged changes separate.
	const modified=records.some(record=>record[1]==='M')
		? new Set(fields((await withIndexCopy(dir,indexFile=>gitResult(dir,
			['-c','diff.autoRefreshIndex=true','diff','--numstat','-z','--no-renames','--no-ext-diff','--no-textconv','--'],{indexFile}))).stdout)
			.map(line=>line.slice(line.indexOf('\t',line.indexOf('\t')+1)+1)))
		: undefined;
	for(const record of records){
		const x=record[0],file=record.slice(3);
		const y=record[1]==='M' && !modified?.has(file)?' ':record[1];
		if(x===' ' && y===' ')continue;
		if(path.win32.isAbsolute(file) || /[\\:\0]/u.test(file) || file.split('/').some(p=>!p || p==='.' || p==='..' || p.toLowerCase()==='.git'))
			throw new Error(tr('Git 返回了不安全的文件名','Git returned an unsafe path'));
		if(x==='?' && y==='?'){
			const prior=files.get(file);
			files.set(file,{file,head:prior?.head??0,stage:0,work:2});
			continue;
		}
		const h=x==='A'?0:1;
		const stage=x==='D'?0:x===' '?h:y===' '||y==='D'?2:3;
		files.set(file,{file,head:h,stage,work:y==='D'?0:y===' '?stage:2});
	}
	let bytes=0;
	const changes=[...files.values()].sort((a,b)=>Buffer.compare(Buffer.from(a.file),Buffer.from(b.file)));
	for(const change of changes){
		if(!change.work)continue;
		const handle=await fs.open(path.join(dir,change.file),'r');
		try{
			const hash=createHash('sha256');let size=0;
			for await(const block of handle.createReadStream({autoClose:false})){
				const chunk=block as Buffer;
				hash.update(chunk);size+=chunk.length;
			}
			change.fingerprint=hash.digest('hex');change.workBytes=size;bytes+=size;
		}finally{await handle.close();}
	}
	const identity=who.identity,signature=digest(JSON.stringify([branch,head,indexHash,changes,who.values]));
	const identitySources={name:who.values.name.slice(-1)[0],email:who.values.email.slice(-1)[0]};
	return {head,branch,signature,identity,identitySources,staged:changes.some(c=>c.head!==c.stage),changes,
		files:new Set([...fields(listed.stdout),...files.keys()]).size,bytes,elapsed:Date.now()-start,platform:process.platform};
}

export interface SaveRecord {head:string;branch:string;message:string;candidate?:string;committed?:string;staged:string[];problem?:string}
export type CommitMode='smart'|'staged'|'amend';

export async function saveVersion(dir:string,confirmed:VersionPreview,message:string,record?:(value:SaveRecord)=>Promise<void>,mode:CommitMode='smart',selected?:ReadonlySet<string>){
	if(!message.trim())throw new Error(tr('请填写提交说明','Enter a commit message'));
	await guardGit(dir);
	const receipt:SaveRecord={head:confirmed.head,branch:confirmed.branch,message,staged:[]};
	try{
		return await withIndex(dir,async(indexFile,locks,publish)=>{
			const check=async()=>{
				const p=await previewVersion(dir,locks);
				if(p.signature!==confirmed.signature)throw new Error(tr('提交身份、HEAD、索引或工作区已变化，请重新预览','Identity, HEAD, index or worktree changed. Preview again.'));
				return p;
			};
			const fresh=await check(),identityArgs=await checkedIdentityArgs(dir,fresh.identity);
			if(!fresh.changes.length)throw new Error(tr('没有待提交的改动','No changes to commit'));
			if(mode!=='smart' && !fresh.staged)throw new Error(tr('请先暂存','Stage changes first'));
			if(mode==='amend' && !fresh.head)throw new Error(tr('没有可修订的提交','No commit to amend'));
			const items=selected?fresh.changes.filter(c=>selected.has(c.file)):fresh.changes;
			if(selected && (fresh.staged || mode!=='smart' || !items.length || selected.size!==items.length))
				throw new Error(tr('自动提交选择已变化或含已有暂存','Automatic selection changed or there are staged changes'));
			await record?.(receipt);
			if(!fresh.staged){
				await gitResult(dir,['add','-A','--pathspec-from-file=-','--pathspec-file-nul'],
					{indexFile,stdin:Buffer.from(items.map(c=>c.file+'\0').join(''))});
			}
			const tree=(await gitResult(dir,['write-tree'],{indexFile})).stdout.toString().trim();
			await assertPrivateManifestTree(dir,tree);
			const prior=fresh.head?await readCommit(dir,fresh.head):undefined;
			if(mode!=='amend' && prior?.commit.tree===tree)throw new Error(tr('没有待提交的改动','No changes to commit'));
			const parents=mode==='amend'?prior!.commit.parent:fresh.head?[fresh.head]:[];
			const original=mode==='amend'?prior!.commit.author:undefined;
			const author=original?{name:original.name,email:original.email,date:original.timestamp+' '+original.offset}:undefined;
			const args=[...identityArgs,'commit-tree','--no-gpg-sign',tree,...parents.flatMap(p=>['-p',p]),'-F','-'];
			const oid=(await gitResult(dir,args,{stdin:message.trim()+'\n',author})).stdout.toString().trim();
			receipt.candidate=oid;await record?.(receipt);
			await check();
			await gitResult(dir,['update-ref','-m','commit: '+message.split('\n')[0]!, 'refs/heads/'+fresh.branch,oid,fresh.head || '0'.repeat(40)]);
			receipt.committed=oid;
			if(!fresh.staged){await publish();receipt.staged=items.map(c=>c.file);}
			await record?.(receipt);return oid;
		});
	}catch(error){
		receipt.problem=String(error);await record?.(receipt);throw error;
	}
}

interface HistoryCursor { tip:string; offset:number }

export async function history(dir:string,cursor?:HistoryCursor,size=20){
	await guardGit(dir,new Set(),true);
	const tip=cursor?.tip??await headOid(dir),offset=cursor?.offset??0;
	if(!tip)return {entries:[],next:undefined};
	if(!/^[0-9a-f]{40}$/u.test(tip) || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(size) || size<1)
		throw new Error('Invalid history cursor');
	const raw=await gitResult(dir,['rev-list','--topo-order','--skip='+offset,'--max-count='+String(size+1),tip]);
	const ids=raw.stdout.toString('ascii').trim().split('\n').filter(Boolean);
	const entries=await Promise.all(ids.slice(0,size).map(id=>readCommit(dir,id)));
	return {entries,next:ids.length>size?{tip,offset:offset+size}:undefined};
}
