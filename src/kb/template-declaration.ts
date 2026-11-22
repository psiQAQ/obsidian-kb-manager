import {stringify} from 'smol-toml';
import { segments } from '../fs/segments.ts';
import { tr } from '../i18n.ts';
import { exclusionFolders } from './template-exclusions.ts';
import {validMinimum} from './template-requirements.ts';
import type {TemplateRequirements} from './template-requirements.ts';

export interface CheckDeclaration {id:string; name:string; path:string; description?:string; linkEvidence?:boolean}
export interface TemplateSource {url:string; author:string; commit:string; license:string; path?:string}
export interface Declaration extends TemplateRequirements {
	$schema?:string; protocolVersion?:1; managedFiles?:string[];
	id?:string; version?:string; name?:string; description?:string; purpose?:string; purposes?:string[];
	entry?:string; pageTemplates?:string[]; sources?:TemplateSource[];
	suggestedExcludedFolders?:string[];
	paths?:Record<string,string>; variables?:Record<string,string|number|boolean>; managed?:string[]; hidden?:string[]; text?:Record<string,string[]>; checks?:CheckDeclaration[];
}

function object(input:unknown):input is Record<string,unknown> {
	return !!input && typeof input==='object' && !Array.isArray(input);
}
function strings(input:unknown):input is string[] {
	return Array.isArray(input) && input.every(value=>typeof value==='string' && value.trim()) && new Set(input).size===input.length;
}
const reservedChecks=new Set(['manifest','properties','links','anchors','canvas','bases','bindings','portability','all']);
const slug=/^[a-z0-9][a-z0-9-]*$/u;
function bad(field:string):never {throw new Error(tr('模板声明字段无效：','Invalid template declaration field: ')+field);}

export function declaration(raw:string):Declaration {
	const data:unknown=JSON.parse(raw);
	if(!object(data))bad('kb-template.json');
	if('protocolVersion' in data && data.protocolVersion!==1)
		throw new Error(tr('不支持该模板协议，请检查管理器版本。','Unsupported template protocol. Check your manager version.')+' · '+String(data.protocolVersion));
	for(const name of Object.keys(data))if(!['$schema','protocolVersion','minManagerVersion','managedFiles','id','version','name','description','purpose','purposes','entry','pageTemplates','dependencies','sources','paths','variables','managed','hidden','text','checks','suggestedExcludedFolders'].includes(name))bad(name);
	if('$schema' in data && typeof data.$schema!=='string')bad('$schema');
	if('minManagerVersion' in data && !validMinimum(data.minManagerVersion))bad('minManagerVersion');
	if('managedFiles' in data){
		if(!strings(data.managedFiles))bad('managedFiles');
		const files=data.managedFiles;
		if(new Set(files.map(file=>file.normalize('NFC').toLowerCase())).size!==files.length)bad('managedFiles');
		if(files.length && (!data.id || !data.version))bad('managedFiles require id and version');
		for(const file of files){
			segments(file);
			if(/^(?:checks\/|kb-template\.json$|kb\.toml$|kb-manager\.json$)/iu.test(file) ||
				!/\.(?:md|base|canvas|txt|json|ya?ml|css)$/iu.test(file))bad('managedFiles.'+file);
		}
	}
	if('dependencies' in data){
		if(!Array.isArray(data.dependencies))bad('dependencies');
		const ids=new Set<string>();
		for(const dep of data.dependencies as unknown[]){
			const id=typeof dep==='string'?dep:object(dep)?dep.id:undefined;
			if(typeof id!=='string' || !id.trim() || ids.has(id))bad('dependencies');
			if(typeof dep!=='string' && (!object(dep) || typeof dep.required!=='boolean' ||
					Object.keys(dep).some(key=>!['id','required','minVersion'].includes(key)) ||
					('minVersion' in dep && !validMinimum(dep.minVersion))))bad('dependencies.'+id);
			ids.add(id);
		}
	}
	for(const name of ['id','version','entry','name','description','purpose']) {
		if(name in data && (typeof data[name]!=='string' || (!data[name] && name!=='description')))bad(name);
	}
	if(typeof data.entry==='string')segments(data.entry);
	for(const name of ['purposes','pageTemplates','hidden'])if(name in data && !strings(data[name]))bad(name);
	for(const folder of (data.pageTemplates??[]) as string[])segments(folder);
	if('suggestedExcludedFolders' in data)exclusionFolders(data.suggestedExcludedFolders,'suggestedExcludedFolders');
	if([data.purpose,...(data.purposes??[]) as string[]].some(value=>value!==undefined && (typeof value!=='string' || !slug.test(value))))bad('purpose');
	if(data.managed!==undefined && (!strings(data.managed) || data.managed.length!==1 || data.managed[0]!=='knowledge.base:overview-bindings'))bad('managed');
	if(data.paths!==undefined){
		if(!object(data.paths))bad('paths');
		for(const [key,value] of Object.entries(data.paths)){
			if(!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) || typeof value!=='string')bad('paths.'+key);
			segments(value);
		}
	}
	if(data.variables!==undefined){
		if(!object(data.variables))bad('variables');
		for(const [key,value] of Object.entries(data.variables)){
			if(!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(key) || !['string','number','boolean'].includes(typeof value) || (typeof value==='number' && !Number.isFinite(value)))bad('variables.'+key);
		}
	}
	if(data.text!==undefined){
		if(!object(data.text))bad('text');
		for(const [file,fields] of Object.entries(data.text)){
			segments(file);
			if(Array.isArray(fields) && fields.includes('kb_root') && !/\.(?:md|base|canvas|txt|json|ya?ml)$/iu.test(file))bad('text.'+file);
			if(/^(?:checks\/|kb-template\.json$|kb\.toml$)/iu.test(file) || !strings(fields) || !fields.every(field=>['kb_name','description','kb_root'].includes(field)))bad('text.'+file);
		}
	}
	if(data.checks!==undefined){
		if(!Array.isArray(data.checks) || data.checks.length>64)bad('checks');
		if(data.checks.length && (!data.id || !data.version))bad('checks require id and version');
		const ids=new Set<string>(), paths=new Set<string>();
		for(const check of data.checks as unknown[]){
			if(!object(check) || typeof check.id!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(check.id) || reservedChecks.has(check.id) || typeof check.name!=='string' || !check.name.trim() ||
				typeof check.path!=='string' || !/^checks\/[^/]+\.mjs$/u.test(check.path) || (check.description!==undefined && typeof check.description!=='string') ||
				(check.linkEvidence!==undefined && typeof check.linkEvidence!=='boolean'))bad('checks');
			segments(check.path);
			if(ids.has(check.id) || paths.has(check.path.toLowerCase()))bad('checks.'+check.id);
			ids.add(check.id); paths.add(check.path.toLowerCase());
		}
	}
	if(data.sources!==undefined){
		if(!Array.isArray(data.sources))bad('sources');
		for(const source of data.sources as unknown[]){
			if(!object(source) || typeof source.url!=='string' || !/^https?:\/\//u.test(source.url) ||
				['author','license','commit'].some(key=>typeof source[key]!=='string' || !source[key]) || (source.path!==undefined && typeof source.path!=='string'))bad('sources');
		}
	}
	return data;
}

export function instanceManifestSeed(spec:Declaration,version:1|2=2){return stringify({version,paths:spec.paths});}

export function verifyDeclaration(spec:Declaration,files:readonly string[],folders:readonly string[]) {
	for(const file of [...Object.keys(spec.text??{}),...(spec.managedFiles??[]),...(spec.checks??[]).map(check=>check.path),...(spec.entry?[spec.entry]:[]),...(spec.managed?.length?['knowledge.base']:[])])
		if(!files.includes(file))throw new Error(tr('缺少声明的文件：','Missing declared file: ')+file);
	for(const dir of spec.pageTemplates??[])if(!folders.includes(dir) && !files.some(name=>name.startsWith(dir+'/')))bad('pageTemplates.'+dir);
	for(const dir of spec.suggestedExcludedFolders??[])if(!folders.includes(dir) && !files.some(name=>name.startsWith(dir+'/')))bad('suggestedExcludedFolders.'+dir);
}
