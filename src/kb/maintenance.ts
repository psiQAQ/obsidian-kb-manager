import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import { segments } from '../fs/paths.ts';
import { VaultDisk,digest,statIfPresent } from '../fs/vault.ts';
import { identityFile, parseIdentity, recheck, writeIdentity } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { isBuiltinWiki, isKepano, kepanoBinding, kepanoBindingAssets, renderBase } from './template.ts';
import { renderKepano, rebindKepano } from './kepano.ts';
import {rebindSlots} from './instance-text.ts';
import { rebind } from './bindings.ts';
import { readManifestFile, replaceLibraryManifest } from './manifest-disk.ts';

export interface Repair {file:string;before:string|null;after:string;fields:string[]}
export interface Report {manual:string[];repairs:Repair[]}
export async function examine(disk:VaultDisk,lib:Library,skeleton:Record<string,string>,destination=lib.location,
	originals?:Map<string,string>):Promise<Report>{
	const manual:string[]=[];
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
	const bindings=await examineBindings(disk,lib,skeleton,destination,originals);
	return {manual:[...manual,...bindings.manual],repairs:bindings.repairs};
}

export async function examineBindings(disk:VaultDisk,lib:Library,skeleton:Record<string,string>,destination=lib.location,
	originals?:Map<string,string>):Promise<Report>{
	const manual:string[]=[], repairs:Repair[]=[];
	for(const binding of lib.identity?.managed??[]){
		if(binding.role!=='template-root' || !binding.offsets || !binding.root)continue;
		try{
			const file=await disk.path(lib.location+'/'+binding.path),stat=await statIfPresent(file);
			if(!stat?.isFile() || stat.nlink!==1)throw new Error(tr('受管文件缺失或不再是独立文件','Managed file is missing or linked'));
			const text=await fs.readFile(file,'utf8');
			if(digest(text)!==binding.fingerprint)throw new Error(tr('受管文件已编辑，保留原文','Managed file was edited. Keeping contents.'));
			const after=rebindSlots(text,binding.offsets,binding.root,destination,binding.path);
			if(text!==after){
				originals?.set(binding.path,text);
				repairs.push({file:binding.path,before:binding.fingerprint,after,fields:[binding.root+' → '+destination]});
			}
		}catch(error){manual.push(binding.path+' · '+String(error));}
	}
	if(lib.identity?.schemaVersion===2 && !lib.identity.managed.some(item=>item.role!=='template-root'))return {manual,repairs};
	if(lib.identity && isKepano(lib.identity.template)){
		const bindingAssets=kepanoBindingAssets(skeleton,lib.identity.template.version);
		let rendered:Record<string,string>|undefined;
		for(const item of lib.identity.managed){
			if(item.role==='template-root')continue;
			if(item.role!=='kepano-bindings' || !kepanoBinding(bindingAssets,item.path)){
				manual.push(tr('检查未知绑定：','Review unrecognized binding: ')+item.path);
				continue;
			}
			try{
				const file=await disk.path(lib.location+'/'+item.path), stat=await statIfPresent(file);
				if(!stat){
					if(item.path.endsWith('.base') || (lib.identity.template.version!=='1' && /^Templates\/.+\.md$/u.test(item.path))){
						rendered??=renderKepano(bindingAssets,destination);
						repairs.push({file:item.path,before:null,after:rendered[item.path]!,fields:[tr('恢复内置模板文件','Restore built-in template file')]});
					}else manual.push(tr('缺少受管页面：','Missing managed page: ')+item.path);
					continue;
				}
				if(!stat.isFile() || stat.nlink!==1)throw new Error(tr('需要独立常规文件','Expected a regular file with a single link'));
				const text=await fs.readFile(file,'utf8');
				if(digest(text)!==item.fingerprint){
					manual.push(tr('受管文件已编辑，需手动检查绑定：','Managed file was edited. Review its bindings manually: ')+item.path);
					continue;
				}
				const previous=item.root??lib.location;
				let result=rebindKepano(item.path,text,previous,destination,bindingAssets);
				if(previous!==lib.location && destination!==lib.location){
					// Health checks after an external move can already have rebound a file to its current location.
					const current=rebindKepano(item.path,result.content,lib.location,destination,bindingAssets);
					result={content:current.content,edits:[...result.edits,...current.edits],manual:current.manual};
				}
				manual.push(...result.manual);
				if(result.edits.length){
					originals?.set(item.path,text);
					repairs.push({file:item.path,before:digest(text),after:result.content,
						fields:result.edits.map(edit=>edit.role+' · '+edit.old+' → '+edit.value)});
				}
			}catch(error){manual.push(item.path+' · '+String(error));}
		}
		return {manual,repairs};
	}
	const binding=lib.identity?.managed.find(item=>item.path==='knowledge.base');
	const builtin=isBuiltinWiki(lib.identity?.template);
	if(!binding || (!builtin && binding.role!=='overview-bindings')){
		manual.push(tr('未知来源的视图与外部路径需人工核对。','Review views of unknown origin and external paths manually.'));return {manual,repairs};
	}
	const file=await disk.path(lib.location+'/knowledge.base');
	const status=await statIfPresent(file);
	if(!status){
		const source=skeleton['knowledge.base'];
		if(!builtin || binding.role==='overview-bindings')manual.push(tr('旧库的受管 Base 缺失，须从原库恢复。','The managed Base is missing. Restore it from the original library.'));
		if(source && builtin && binding.role!=='overview-bindings')repairs.push({file:'knowledge.base',before:null,after:renderBase(source,destination),fields:[tr('补齐内置总览','Restore the built-in overview')]});
		return {manual,repairs};
	}
	if(!status.isFile() || status.nlink!==1)throw new Error(tr('knowledge.base 必须为独立常规文件','knowledge.base must be a regular file with a single link'));
	const source=await fs.readFile(file,'utf8');
	if(digest(source)!==binding.fingerprint){
		manual.push(tr('受管文件已编辑，需手动检查绑定：','Managed file was edited. Review its bindings manually: ')+'knowledge.base');
		return {manual,repairs};
	}
	try{
		const result=rebind(source,binding.root??lib.location,destination);
		manual.push(...result.manual);
		if(result.edits.length){
			originals?.set('knowledge.base',source);
			repairs.push({file:'knowledge.base',before:digest(source),after:result.content,
				fields:result.edits.map(e=>e.role+'：'+e.old+' → '+e.value)});
		}
	}catch(error){manual.push(String(error));}
	return {manual,repairs};
}

export interface VisibleFiles {
	replace(relative:string,before:string,after:string):Promise<void>;
	create(relative:string,content:string):Promise<void>;
}
export async function applyRepair(disk:VaultDisk,config:Config,lib:Library,item:Repair,files:VisibleFiles,skeleton:Record<string,string>={}){
	const current=await recheck(disk,config,lib);
	const binding=current.identity?.managed.find(m=>m.path===item.file);
	const template=lib.identity?.template;
	const authorized=binding?.role==='template-root' ? item.before!==null : template && isKepano(template)
		? binding?.role==='kepano-bindings' && kepanoBinding(kepanoBindingAssets(skeleton,template.version),item.file)
			&& (item.before!==null || item.file.endsWith('.base') || (template.version!=='1' && /^Templates\/.+\.md$/u.test(item.file)))
		: item.file==='knowledge.base';
	if(!binding || !authorized || lib.identity?.archived)throw new Error(tr('此文件未授权修复','This file is not managed for repair'));
	if(item.before!==null && item.before!==binding.fingerprint)
		throw new Error(tr('受管文件已编辑','Managed file was edited'));
	const fresh=(await examineBindings(disk,current,skeleton)).repairs.find(candidate=>candidate.file===item.file);
	if(!fresh || fresh.before!==item.before || fresh.after!==item.after)throw new Error(tr('修复预览已变化','Repair preview changed'));
	const {raw,signature}=await readManifestFile(await disk.path(lib.location+'/'+identityFile));
	if(signature!==current.signature)throw new Error(tr('清单已变化，请重新预览','Manifest changed. Preview again'));
	const identity=parseIdentity(raw);
	const updated=identity.managed.find(entry=>entry.path===item.file)!;
	updated.root=lib.location;
	updated.fingerprint=digest(item.after);
	const manifest=writeIdentity(raw,identity);
	segments(item.file);
	const relative=lib.location+'/'+item.file;
	const absolute=await disk.path(relative);
	if(item.before===null){
		if(await statIfPresent(absolute))throw new Error(tr('文件已出现，请刷新','The file now exists. Refresh the preview.'));
		await files.create(relative,item.after);
	}else await files.replace(relative,item.before,item.after);
	await replaceLibraryManifest(disk,lib.location,signature,manifest);
}
