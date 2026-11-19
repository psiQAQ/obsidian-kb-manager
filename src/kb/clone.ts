import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import {gitResult} from '../git/network-native.ts';
import { tr } from '../i18n.ts';

import { address } from '../git/network-http.ts';
import { tree,resolveRef,authOptions } from '../git/network.ts';
import type { Credentials } from '../git/network.ts';
import { VaultDisk, statIfPresent, validateFolders } from '../fs/vault.ts';
import { segments } from '../fs/paths.ts';
import { renameNewDirectory } from '../fs/publish.ts';
import { ancestorWarnings } from './create.ts';
import { discover, identityFile, parseIdentity } from './catalog.ts';
import type { Config } from './catalog.ts';
import { readMapping } from './mapping.ts';

export interface CloneInput {parent:string; name:string; url:string}
export async function cloneTarget(disk:VaultDisk,config:Config,input:CloneInput){
	validateFolders(disk,config.parents,config.templates);
	if(!config.parents.includes(input.parent) || segments(input.name).length!==1)throw new Error(tr('请选择已登记的父目录和新目录名','Choose a registered parent and a new folder name'));
	const relative=input.parent+'/'+input.name;
	if(await statIfPresent(await disk.path(relative)))throw new Error(tr('目录已存在','Directory already exists'));
	const route=await address(undefined,input.url);
	return {relative,url:route.url,display:route.display,routeDigest:route.signature,warnings:await ancestorWarnings(disk,relative)};
}

export async function downloadLibrary(disk:VaultDisk,config:Config,input:CloneInput,auth?:Credentials){
	const target=await cloneTarget(disk,config,input);
	const parent=await disk.path(input.parent);
	await fs.mkdir(parent,{recursive:true});
	const temporary=await fs.mkdtemp(join(parent,'.kb-clone-'));
	const initial=await fs.lstat(temporary,{bigint:true});
	let published=false;
	async function cleanup(){
		if(published)return;
		const current=await fs.lstat(temporary,{bigint:true});
		if(!current.isDirectory() || current.dev!==initial.dev || current.ino!==initial.ino)throw new Error(tr('临时克隆目录已变化','Temporary clone directory changed'));
		await fs.rm(temporary,{recursive:true});
	}
	try{

		await gitResult(undefined,['clone','--template=','--no-checkout','--no-local','--no-recurse-submodules','--',target.url,temporary],authOptions(target.url,auth));
		const head=await resolveRef(temporary,'HEAD');
		const files=await tree(temporary,head);
		if(!files.has(identityFile) && !files.has('kb.toml'))throw new Error(tr('远端缺少知识库身份或 kb.toml','Remote repository contains neither a library identity nor kb.toml'));
		const read=async(file:string)=>new TextDecoder('utf-8',{fatal:true}).decode((await gitResult(temporary,['cat-file','blob',head+':'+file])).stdout);
		const identity=files.has(identityFile)?parseIdentity(await read(identityFile)):undefined;
		if(files.has('kb.toml'))readMapping(await read('kb.toml'));
		if([...files.keys()].some(f=>f.split('/').some(p=>p.toLowerCase()===disk.configDir.toLowerCase())))throw new Error(tr('远端包含 Vault 配置目录','Remote tree contains a vault configuration directory'));
		const branch=(await gitResult(temporary,['symbolic-ref','--short','HEAD'])).stdout.toString().trim();
		if(!branch)throw new Error(tr('远端没有默认分支','Remote has no default branch'));
		return {target,head,branch,files:[...files.keys()],cleanup,publish:async(current:Config)=>{
			if(published)throw new Error(tr('已导入','Already imported'));
			const fresh=await cloneTarget(disk,current,input);
			if(JSON.stringify(fresh)!==JSON.stringify(target))throw new Error(tr('目标已变化，请重新预览','Destination changed. Preview again.'));
			if(identity && (await discover(disk,current)).some(l=>l.identity?.id===identity.id))throw new Error(tr('相同身份的知识库已存在','A library with the same ID already exists'));
			if(await resolveRef(temporary,'refs/heads/'+branch)!==head)throw new Error(tr('克隆分支已变化','Cloned branch changed'));
			await gitResult(temporary,['read-tree','--reset','-u',head]);
			await renameNewDirectory(temporary,await disk.path(target.relative));
			published=true;
		}};
	}catch(error){await cleanup();throw error;}
}
