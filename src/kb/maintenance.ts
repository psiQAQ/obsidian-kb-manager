import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { segments } from '../fs/paths.ts';
import { VaultDisk,digest,statIfPresent } from '../fs/vault.ts';
import { recheck } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { renderBase } from './template.ts';
import { rebind } from './bindings.ts';

export interface Repair {file:string;before:string|null;after:string;fields:string[]}
export interface Report {manual:string[];repairs:Repair[]}
export async function examine(disk:VaultDisk,lib:Library,skeleton:Record<string,string>,destination=lib.location):Promise<Report>{
	const manual:string[]=[], repairs:Repair[]=[];
	if(lib.problem)manual.push(lib.problem);
	if(lib.duplicate)manual.push('ID 重复');
	if(lib.git!=='local')manual.push('Git：'+lib.git);
	if(lib.identity?.entry && !(await statIfPresent(await disk.path(lib.location+'/'+lib.identity.entry)))?.isFile())manual.push('缺少入口 '+lib.identity.entry);
	if(lib.mapping){
		for(const [role,relative] of Object.entries(lib.mapping)){
			if(typeof relative!=='string')continue;
			const status=await statIfPresent(await disk.path(lib.location+'/'+relative));
			const valid=['index','log','overview'].includes(role)?status?.isFile():status?.isDirectory();
			if(!valid)manual.push('检查映射 '+role+' → '+relative);
		}
	}
	const binding=lib.identity?.managed.find(item=>item.path==='knowledge.base');
	const builtin=lib.identity?.template.id==='llm-wiki' && lib.identity.template.version==='1';
	if(!binding || (!builtin && binding.role!=='overview-bindings')){
		manual.push('未知来源的视图与外部路径需人工核对。');return {manual,repairs};
	}
	const file=await disk.path(lib.location+'/knowledge.base');
	const status=await statIfPresent(file);
	if(!status){
		const source=skeleton['knowledge.base'];
		if(!builtin || binding.role==='overview-bindings')manual.push('旧库的受管 Base 缺失，须从原库恢复。');
		if(source && builtin && binding.role!=='overview-bindings')repairs.push({file:'knowledge.base',before:null,after:renderBase(source,destination),fields:['补齐内置 v1 总览']});
		return {manual,repairs};
	}
	if(!status.isFile())throw new Error('预期常规文件 knowledge.base');
	const source=await fs.readFile(file,'utf8');
	try{
		const result=rebind(source,binding.root??lib.location,destination);
		manual.push(...result.manual);
		if(result.edits.length)repairs.push({file:'knowledge.base',before:digest(source),after:result.content,
			fields:result.edits.map(e=>e.role+'：'+e.old+' → '+e.value)});
	}catch(error){manual.push(String(error));}
	return {manual,repairs};
}

export interface VisibleFiles {
	replace(relative:string,before:string,after:string):Promise<void>;
	create(relative:string,content:string):Promise<void>;
}
export async function applyRepair(disk:VaultDisk,config:Config,lib:Library,item:Repair,files:VisibleFiles){
	await recheck(disk,config,lib);
	if(lib.identity?.archived || item.file!=='knowledge.base' || !lib.identity ||
		!lib.identity.managed.some(m=>m.path===item.file))throw new Error('此文件未授权修复');
	segments(item.file);
	const relative=lib.location+'/'+item.file;
	const absolute=await disk.path(relative);
	if(item.before===null){
		if(await statIfPresent(absolute))throw new Error('文件已出现，请刷新');
		await files.create(relative,item.after);
	}else await files.replace(relative,item.before,item.after);
}

export async function checkIndexLinks(disk:VaultDisk,lib:Library):Promise<string[]> {
	if(!lib.mapping)return [];
	const index=await disk.path(lib.location+'/'+lib.mapping.index);
	if(!(await statIfPresent(index))?.isFile())return [];
	const text=await fs.readFile(index,'utf8'), issues=[];
	for(const link of text.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/gu)){
		const raw=link[1];
		if(!raw || /^[a-z]+:/iu.test(raw))continue;
		try{
			const relative=path.posix.normalize(path.posix.join(path.posix.dirname(lib.mapping.index),decodeURIComponent(raw)));
			segments(relative);
			if(!await statIfPresent(await disk.path(lib.location+'/'+relative)))issues.push('索引链接缺少目标：'+raw);
		}catch{issues.push('索引链接需人工核对：'+raw);}
	}
	return issues;
}
