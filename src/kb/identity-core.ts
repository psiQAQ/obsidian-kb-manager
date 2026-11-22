import { parse, stringify } from 'smol-toml';
import { tr } from '../i18n.ts';
import { segments } from '../fs/segments.ts';
import { gitDefaults, readGit } from '../preferences.ts';
import type { GitPreferences } from '../preferences.ts';
import { mappingFromPaths } from './mapping.ts';
import { TomlEdits } from './toml-edit.ts';
import { exclusionFolders } from './template-exclusions.ts';
import {validateManagedPath} from './template-file-record.ts';
import type {TemplateFileRecord} from './template-file-record.ts';

export const identityFile = 'kb.toml';
export interface ManagedFile { path: string; fingerprint: string; root?: string; offsets?:number[]; role?: 'overview-bindings' | 'kepano-bindings' | 'template-root' }
export interface Identity {
	schemaVersion: 1|2; id: string; displayName: string; description: string; archived: boolean;
	template: {id: string; version: string}; managed: ManagedFile[]; entry?: string;
	excludedFolders?:string[];
}
export interface CheckKitRecord {protocol:1; version:string; digests:Record<string,string>}

function table(value:unknown):Record<string,unknown>|undefined {
	if(!value || typeof value!=='object')return undefined;
	const prototype:unknown=Object.getPrototypeOf(value);
	return prototype===Object.prototype || prototype===null?value as Record<string,unknown>:undefined;
}

export function parseCheckKit(input:unknown):CheckKitRecord {
	const value=table(input), digests=table(value?.digests);
	const invalid=()=>new Error(tr('通用检验套件记录无效','Invalid common check kit record'));
	if(value?.protocol!==1 || typeof value.version!=='string' || !value.version.trim() || !digests)throw invalid();
	const paths=new Set<string>();
	const entries=Object.entries(digests).map(([path,digest]):[string,string]=>{
		const key=path.normalize('NFC').toLowerCase();
		if((path!=='checks/kb-check.cjs' && !/^checks\/common\/[^/]+\.mjs$/u.test(path)) ||
			typeof digest!=='string' || !/^[a-f0-9]{64}$/u.test(digest) || paths.has(key))throw invalid();
		segments(path);
		paths.add(key);
		return [path,digest];
	});
	return {protocol:1,version:value.version,digests:Object.fromEntries(entries)};
}

function parseTemplateFiles(input:unknown):TemplateFileRecord{
	const value=table(input),digests=table(value?.digests);
	const invalid=()=>new Error(tr('受管模板文件记录无效','Invalid managed template file record'));
	if(typeof value?.version!=='string' || !value.version.trim() || !digests)throw invalid();
	const paths=new Set<string>();
	const entries=Object.entries(digests).map(([file,digest]):[string,string]=>{
		validateManagedPath(file);
		const key=file.normalize('NFC').toLowerCase();
		if(typeof digest!=='string' || !/^[a-f0-9]{64}$/u.test(digest) || paths.has(key))throw invalid();
		paths.add(key);
		return [file,digest];
	});
	return {version:value.version,digests:Object.fromEntries(entries)};
}

function manager(input:unknown):Identity {
	const invalid=()=>new Error(tr('知识库身份字段无效','Invalid identity fields'));
	const value=table(input);
	if(!value)throw invalid();
	if(value.schemaVersion!==1 && value.schemaVersion!==2)throw new Error(tr('不支持的身份格式：','Unsupported identity schema: ')+String(value.schemaVersion));
	const {id,displayName,description,archived,entry}=value;
	const template=table(value.template);
	if(typeof id!=='string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)
		|| typeof displayName!=='string' || !displayName.trim() || typeof description!=='string'
		|| typeof archived!=='boolean' || typeof template?.id!=='string' || !template.id.trim()
		|| typeof template.version!=='string' || !template.version.trim())throw invalid();
	if(entry!==undefined) {
		if(typeof entry!=='string')throw invalid();
		segments(entry);
	}
	const managed=Array.isArray(value.managed)?value.managed:value.managed===undefined?[]:undefined;
	if(!managed)throw invalid();
	const paths=new Set<string>();
	const bindings=managed.map((item:unknown):ManagedFile=>{
		const binding=table(item);
		const error=()=>new Error(tr('受管文件声明无效','Invalid managed file'));
		if(!binding)throw error();
		const {path,fingerprint,root,role,offsets}=binding;
		if(typeof path!=='string' || typeof fingerprint!=='string'
			|| (root!==undefined && typeof root!=='string')
			|| (role!==undefined && role!=='overview-bindings' && role!=='kepano-bindings' && role!=='template-root'))throw error();
		segments(path);
		if(root!==undefined)segments(root);
		const name=path.normalize('NFC').toLowerCase();
		if(paths.has(name))throw error();
		paths.add(name);
		if(role==='template-root'){
			if(!root || !Array.isArray(offsets) || !offsets.length || !offsets.every((v,i)=>Number.isSafeInteger(v) && v>=0 && (!i || v>=offsets[i-1])))throw error();
			if(!/\.(?:md|base|canvas|txt|json|ya?ml)$/iu.test(path) || /^(?:checks\/|kb-template\.json$)/iu.test(path))throw error();
			return {path,fingerprint,root,role,offsets:offsets as number[]};
		}
		return {path,fingerprint,root,role};
	});
	const excludedFolders=value.excludedFolders===undefined?undefined:exclusionFolders(value.excludedFolders,'manager.excludedFolders');
	return {schemaVersion:value.schemaVersion,id:id.toLowerCase(),displayName,description,archived,template:{id:template.id,version:template.version},managed:bindings,entry,excludedFolders};
}

function document(raw:string) {
	const data=parse(raw.replace(/^\uFEFF/u,''));
	if(data.version!==1 && data.version!==2)throw new Error(tr('kb.toml 的 version 必须为 1 或 2','kb.toml requires version = 1 or 2'));
	return data;
}

export function readManifest(raw:string) {
	const data=document(raw);
	const preferences=table(data.preferences);
	if(data.preferences!==undefined && !preferences)throw new Error(tr('preferences 必须为 TOML 表','preferences must be a TOML table'));
	const identity=data.manager===undefined?undefined:manager(data.manager);
	if(identity && identity.schemaVersion!==data.version)throw new Error(tr('清单与身份版本不一致','Manifest and identity versions differ'));
	const sharedWiki=identity?.template.id==='llm-wiki' && identity.template.version==='2';
	const paths=table(data.paths);
	if(data.version===2 && data.paths!==undefined){
		if(!paths)throw new Error(tr('paths 必须为 TOML 表','paths must be a TOML table'));
		for(const value of Object.values(paths)){
			if(typeof value!=='string')throw new Error(tr('映射必须为库内相对路径','Expected a library-relative path'));
			segments(value);
		}
	}
	const hasLegacyLayout=paths && ['wiki','raw','reports','index','log','overview'].every(role=>typeof paths[role]==='string');
	const mapping=data.version===1 && data.paths!==undefined ? mappingFromPaths(data.paths,!sharedWiki) :
		hasLegacyLayout ? mappingFromPaths(Object.fromEntries(Object.entries(paths).filter(([name])=>
			['raw','wiki','reports','templates','index','log','overview','clippings'].includes(name))),false) : undefined;
	return {
		identity,
		mapping,
		preferences:readGit(preferences),
		...(data.checkKit!==undefined && {checkKit:parseCheckKit(data.checkKit)}),
		...(data.templateFiles!==undefined && {templateFiles:parseTemplateFiles(data.templateFiles)}),
	};
}

export function parseIdentity(raw:string):Identity {
	const identity=readManifest(raw).identity;
	if(!identity)throw new Error(tr('kb.toml 缺少 [manager]','kb.toml is missing [manager]'));
	return identity;
}

export function writeIdentity(raw:string, identity:Identity) {
	const next=manager(identity);
	const original=raw || 'version = 1\n';
	const current=readManifest(original).identity;
	const changes=new TomlEdits(original);
	if(document(original).version!==next.schemaVersion)changes.field([],'version',next.schemaVersion);
	if(!current) {
		changes.append(stringify({manager:{...next,managed:next.managed.length?next.managed:undefined}}));
	} else {
		for(const field of ['schemaVersion','id','displayName','description','archived','entry'] as const) {
			if(next[field]!==current[field])changes.field(['manager'],field,next[field]);
		}
		if(JSON.stringify(next.excludedFolders)!==JSON.stringify(current.excludedFolders))
			changes.field(['manager'],'excludedFolders',next.excludedFolders);
		for(const field of ['id','version'] as const) {
			if(next.template[field]!==current.template[field])changes.field(['manager','template'],field,next.template[field]);
		}
		if(current.managed.some((binding,index)=>binding.path!==next.managed[index]?.path))
			throw new Error(tr('更新受管文件时须保留现有文件顺序','Preserve the existing managed file order when updating bindings'));
		for(const [index,binding] of current.managed.entries()) {
			for(const field of ['fingerprint','root','role'] as const) {
				const value=next.managed[index]?.[field];
				if(value!==binding[field])changes.field(['manager','managed',index],field,value);
			}
			const offsets=next.managed[index]?.offsets;
			if(JSON.stringify(offsets)!==JSON.stringify(binding.offsets))changes.field(['manager','managed',index],'offsets',offsets);
		}
		if(next.managed.length>current.managed.length)
			changes.append(stringify({manager:{managed:next.managed.slice(current.managed.length)}}));
	}
	const output=changes.finish();
	parseIdentity(output);
	return output;
}

export function writeTemplateFileRecord(raw:string,record:TemplateFileRecord){
	const current=readManifest(raw).templateFiles;
	const next=parseTemplateFiles({...record,digests:{...current?.digests,...record.digests}});
	const changes=new TomlEdits(raw);
	if(!current)changes.append(stringify({templateFiles:{...next}}));
	else {
		if(current.version!==next.version)changes.field(['templateFiles'],'version',next.version);
		for(const [file,digest] of Object.entries(next.digests)){
			if(current.digests[file]!==digest)changes.field(['templateFiles','digests'],file,digest);
		}
	}
	const output=changes.finish();
	readManifest(output);
	return output;
}

export function retireTemplateFiles(raw:string,paths:ReadonlySet<string>){
	if(!paths.size)return raw;
	const {identity,templateFiles}=readManifest(raw);
	const changes=new TomlEdits(raw);
	for(const path of paths){
		if(templateFiles?.digests[path])changes.field(['templateFiles','digests'],path,undefined);
	}
	for(const [index,file] of (identity?.managed ?? []).entries()){
		if(file.role==='template-root' && paths.has(file.path))changes.removeArrayItem(['manager','managed',index]);
	}
	const output=changes.finish();
	readManifest(output);
	return output;
}

export function writeCheckKit(raw:string, record:CheckKitRecord) {
	const current=readManifest(raw).checkKit;
	const next=parseCheckKit({...record,digests:{...current?.digests,...record.digests}});
	const changes=new TomlEdits(raw);
	if(!current)changes.append(stringify({checkKit:{...next}}));
	else {
		if(current.version!==next.version)changes.field(['checkKit'],'version',next.version);
		for(const [path,digest] of Object.entries(next.digests)) {
			if(current.digests[path]!==digest)changes.field(['checkKit','digests'],path,digest);
		}
	}
	const output=changes.finish();
	readManifest(output);
	return output;
}

export function writePreferences(raw:string, overrides:Partial<GitPreferences>) {
	const data=document(raw);
	const previous=table(data.preferences);
	if(data.preferences!==undefined && !previous)throw new Error(tr('preferences 必须为 TOML 表','preferences must be a TOML table'));
	const next=readGit(overrides);
	const changes=new TomlEdits(raw);
	if(!previous) {
		if(Object.keys(next).length)changes.append(stringify({preferences:next}));
	} else {
		for(const key of Object.keys(gitDefaults) as (keyof GitPreferences)[]) {
			if(previous[key]!==next[key])changes.field(['preferences'],key,next[key]);
		}
	}
	const output=changes.finish();
	readManifest(output);
	return output;
}

export function withLibraryIgnores(raw:string) {
	const newline=raw.includes('\r\n')?'\r\n':'\n';
	const rules=raw.replace(/^\uFEFF/u,'').split(/\r?\n/u).filter(line=>line.trim() && !line.startsWith('#'));
	const required=['/.log/','/'+identityFile];
	// Only trailing rules are safe to reuse: a later user negation can override an earlier ignore.
	const trailing=new Set<string>();
	for(const rule of rules.reverse()){
		if(!required.includes(rule))break;
		trailing.add(rule);
	}
	const missing=required.filter(rule=>!trailing.has(rule));
	if(!missing.length)return raw;
	return raw+(raw && !raw.endsWith('\n')?newline:'')+missing.join(newline)+newline;
}

export function withManifestIgnore(raw:string) {
	const lines=raw.replace(/^\uFEFF/u,'').split(/\r?\n/u);
	const last=lines.filter(line=>line.trim() && !line.startsWith('#')).pop();
	if(last==='/'+identityFile)return raw;
	const newline=raw.includes('\r\n')?'\r\n':'\n';
	return raw+(raw && !raw.endsWith('\n')?newline:'')+'/'+identityFile+newline;
}
