import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
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
	if(lib.duplicate)manual.push(tr('ID 重复','Duplicate library ID'));
	if(lib.git!=='local')manual.push('Git：'+lib.git);
	if(lib.identity?.entry && !(await statIfPresent(await disk.path(lib.location+'/'+lib.identity.entry)))?.isFile())manual.push(tr('缺少入口 ','Missing entry file: ')+lib.identity.entry);
	if(lib.mapping){
		for(const [role,relative] of Object.entries(lib.mapping)){
			if(typeof relative!=='string')continue;
			const status=await statIfPresent(await disk.path(lib.location+'/'+relative));
			const valid=['index','log','overview'].includes(role)?status?.isFile():status?.isDirectory();
			if(!valid)manual.push(tr('检查映射 ','Check mapping: ')+role+' → '+relative);
		}
	}
	const binding=lib.identity?.managed.find(item=>item.path==='knowledge.base');
	const builtin=lib.identity?.template.id==='llm-wiki' && lib.identity.template.version==='1';
	if(!binding || (!builtin && binding.role!=='overview-bindings')){
		manual.push(tr('未知来源的视图与外部路径需人工核对。','Review views of unknown origin and external paths manually.'));return {manual,repairs};
	}
	const file=await disk.path(lib.location+'/knowledge.base');
	const status=await statIfPresent(file);
	if(!status){
		const source=skeleton['knowledge.base'];
		if(!builtin || binding.role==='overview-bindings')manual.push(tr('旧库的受管 Base 缺失，须从原库恢复。','The managed Base is missing. Restore it from the original library.'));
		if(source && builtin && binding.role!=='overview-bindings')repairs.push({file:'knowledge.base',before:null,after:renderBase(source,destination),fields:[tr('补齐内置 v1 总览','Restore the built-in v1 overview')]});
		return {manual,repairs};
	}
	if(!status.isFile())throw new Error(tr('预期常规文件 knowledge.base','Expected a regular knowledge.base file'));
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
		!lib.identity.managed.some(m=>m.path===item.file))throw new Error(tr('此文件未授权修复','This file is not managed for repair'));
	segments(item.file);
	const relative=lib.location+'/'+item.file;
	const absolute=await disk.path(relative);
	if(item.before===null){
		if(await statIfPresent(absolute))throw new Error(tr('文件已出现，请刷新','The file now exists. Refresh the preview.'));
		await files.create(relative,item.after);
	}else await files.replace(relative,item.before,item.after);
}
