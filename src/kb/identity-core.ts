import { parse, stringify } from 'smol-toml';
import { tr } from '../i18n.ts';
import { segments } from '../fs/segments.ts';
import { gitDefaults, readGit } from '../preferences.ts';
import type { GitPreferences } from '../preferences.ts';
import { mappingFromPaths } from './mapping.ts';
import { TomlEdits } from './toml-edit.ts';

export const identityFile = 'kb.toml';
export interface ManagedFile { path: string; fingerprint: string; root?: string; offsets?:number[]; role?: 'overview-bindings' | 'kepano-bindings' | 'template-root' }
export interface Identity {
	schemaVersion: 1|2; id: string; displayName: string; description: string; archived: boolean;
	template: {id: string; version: string}; managed: ManagedFile[]; entry?: string;
}

function table(value:unknown):Record<string,unknown>|undefined {
	if(!value || typeof value!=='object')return undefined;
	const prototype:unknown=Object.getPrototypeOf(value);
	return prototype===Object.prototype || prototype===null?value as Record<string,unknown>:undefined;
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
	return {schemaVersion:value.schemaVersion,id:id.toLowerCase(),displayName,description,archived,template:{id:template.id,version:template.version},managed:bindings,entry};
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
		}
		if(next.managed.length>current.managed.length)
			changes.append(stringify({manager:{managed:next.managed.slice(current.managed.length)}}));
	}
	const output=changes.finish();
	parseIdentity(output);
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
	const rules=raw.split(/\r?\n/u).filter(line=>line && !line.startsWith('#'));
	if(rules.slice(-2).join('\n')==='/.log/\n/kb.toml')return raw;
	return withManifestIgnore(raw+(raw && !raw.endsWith('\n')?newline:'')+'/.log/'+newline);
}

export function withManifestIgnore(raw:string) {
	const lines=raw.replace(/^\uFEFF/u,'').split(/\r?\n/u);
	const last=lines.filter(line=>line.trim() && !line.startsWith('#')).pop();
	if(last==='/'+identityFile)return raw;
	const newline=raw.includes('\r\n')?'\r\n':'\n';
	return raw+(raw && !raw.endsWith('\n')?newline:'')+'/'+identityFile+newline;
}
