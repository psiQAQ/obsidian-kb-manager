import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { renameNewDirectory } from '../fs/publish.ts';
import { gitResult } from './network-native.ts';

export const repository=(dir:string)=>({dir,gitdir:path.join(dir,'.git')});

export async function initializeRepository(dir:string){
	// Publish metadata only after init succeeds, including when attaching Git to an existing library.
	const staging=await fs.mkdtemp(path.join(dir,'.kb-init-'));
	try{
		await gitResult(staging,['init','--quiet','--template=','--initial-branch=main']);
		await renameNewDirectory(path.join(staging,'.git'),path.join(dir,'.git'));
	}finally{await fs.rm(staging,{recursive:true,force:true});}
}

export const text=async(dir:string,args:string[])=>(await gitResult(dir,args)).stdout.toString('utf8').trimEnd();
export const fields=(buffer:Buffer)=>buffer.toString('utf8').split('\0').filter(Boolean);
export async function headOid(dir:string){
	const result=await gitResult(dir,['rev-parse','--verify','--quiet','HEAD'],{allowedExitCodes:[0,1]});
	return result.stdout.toString('ascii').trim();
}

function person(line:string){
	const match=/^(.*) <(.*)> (\d+) ([+-]\d{4})$/u.exec(line);
	if(!match)throw new Error('Invalid commit identity');
	return {name:match[1]!,email:match[2]!,timestamp:Number(match[3]),offset:match[4]!};
}
export async function readCommit(dir:string,oid:string){
	if(!/^[0-9a-f]{40}$/u.test(oid))throw new Error('Invalid commit ID');
	const raw=(await gitResult(dir,['cat-file','commit',oid])).stdout.toString('utf8');
	const end=raw.indexOf('\n\n'),lines=raw.slice(0,end).split('\n');
	const value=(key:string)=>lines.find(l=>l.startsWith(key+' '))?.slice(key.length+1) ?? '';
	return {oid,commit:{tree:value('tree'),parent:lines.filter(l=>l.startsWith('parent ')).map(l=>l.slice(7)),
		author:person(value('author')),committer:person(value('committer')),message:raw.slice(end+2)}};
}
