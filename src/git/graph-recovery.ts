import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {digest,statIfPresent} from '../fs/vault.ts';
import {tr} from '../i18n.ts';
import {refName,tree} from './network.ts';
import {fields} from './repository.ts';
import {gitResult} from './network-native.ts';

export type Operation = 'cherry-pick'|'revert'|'merge'|'rebase';
const markers = {'cherry-pick':'CHERRY_PICK_HEAD',revert:'REVERT_HEAD',merge:'MERGE_HEAD',rebase:'rebase-merge'} as const;
export async function activeOperation(dir:string):Promise<Operation|undefined>{
	for(const operation of Object.keys(markers) as Operation[])
		if(await statIfPresent(join(dir,'.git',markers[operation])))return operation;
	return undefined;
}
export function writableGraphPath(file:string){
	const parts=file.split('/');
	return !/[\\:\0]/u.test(file) && parts.every(p=>p && p!=='.' && p!=='..' && !/^\.git$/iu.test(p))
		&& !/^(?:kb\.toml|kb-manager\.json|\.obsidian|\.kb-manager|\.log)(?:\/|$)/iu.test(file);
}
export async function checkGraphPaths(dir:string,files:Iterable<string>){
	for(const file of files){
		if(!writableGraphPath(file))throw new Error(tr('操作涉及知识库管理路径','Operation touches a managed path')+' · '+file);
		const stat=await statIfPresent(join(dir,file));
		if(stat && (!stat.isFile() || stat.nlink!==1))throw new Error(tr('文件不是独立普通文件','Expected an ordinary unlinked file')+' · '+file);
	}
}

/** Only resume ordinary Git-generated sequences. Replay instructions are repository input. */
export async function recoveryState(dir:string,operation:Operation){
	const gd=join(dir,'.git');
	const fileText=(file:string)=>fs.readFile(join(gd,file),'utf8');
	const oidPattern=/^[0-9a-f]{40}$/u;
	const commits=new Set<string>();
	const metadata:string[]=[];
	let branchRef:string|undefined;
	if(await statIfPresent(join(gd,'MERGE_AUTOSTASH')))throw new Error(tr('请在创建自动贮藏的 Git 客户端完成此次操作','Complete this operation in the client that created the autostash'));
	if(operation==='rebase'){
		const folder='rebase-merge/';
		const allowed=new Set(['head-name','onto','orig-head','git-rebase-todo','git-rebase-todo.backup','done',
			'msgnum','end','message','author-script','patch','stopped-sha','interactive','no-reschedule-failed-exec',
			'drop_redundant_commits','rewritten-list','rewritten-pending','amend','quiet','verbose']);
		for(const name of (await fs.readdir(join(gd,folder))).sort()){
			if(!allowed.has(name))throw new Error(tr('此变基使用了额外选项，请在原 Git 客户端继续','Resume this customized rebase in its original Git client')+' · '+name);
			const raw=await fileText(folder+name);
			metadata.push(name,digest(raw));
			if(name==='head-name' && raw.trim()!=='detached HEAD'){
				if(!raw.trim().startsWith('refs/heads/'))throw new Error('Invalid rebase branch');
				refName(raw.trim().slice(11));
				branchRef=raw.trim();
			}
			if(['onto','orig-head','stopped-sha'].includes(name)){
				if(!oidPattern.test(raw.trim()))throw new Error('Invalid rebase commit');
				commits.add(raw.trim());
			}
			if(name==='git-rebase-todo' || name==='done'){
				for(const line of raw.split(/\r?\n/u)){
					if(!line.trim() || line.startsWith('#'))continue;
					const match=/^(?:pick|drop) ([0-9a-f]{7,40})(?:\s|$)/u.exec(line);
					if(!match)throw new Error(tr('请在原 Git 客户端完成交互式变基','Complete this interactive rebase in its original Git client'));
					commits.add((await gitResult(dir,['rev-parse','--verify',match[1]+'^{commit}'])).stdout.toString().trim());
				}
			}
		}
	}else{
		const oid=(await fileText(markers[operation])).trim();
		if(!oidPattern.test(oid))throw new Error('Unsupported operation head');
		commits.add(oid);
		const original=await statIfPresent(join(gd,'ORIG_HEAD'));
		if(original && operation==='merge'){
			const value=(await fileText('ORIG_HEAD')).trim();
			if(!oidPattern.test(value))throw new Error('Invalid original HEAD');
			commits.add(value);
		}
	}
	const conflicts=fields((await gitResult(dir,['diff','--name-only','--diff-filter=U','-z','--'])).stdout);
	const head=(await gitResult(dir,['rev-parse','HEAD'])).stdout.toString().trim();
	const before=await tree(dir,head),paths=new Set<string>();
	for(const oid of commits){
		const after=await tree(dir,oid);
		for(const file of new Set([...before.keys(),...after.keys()]))if(before.get(file)!==after.get(file))paths.add(file);
	}
	return {metadata:digest(JSON.stringify(metadata)),commits:[...commits],paths:[...paths],conflicts,branchRef};
}
