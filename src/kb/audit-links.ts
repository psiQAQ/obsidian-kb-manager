import {posix as path} from 'node:path';
import {tr} from '../i18n.ts';
import type {Mapping} from './mapping.ts';
import type {AuditNote, AuditReport} from './audit-types.ts';
import {inlineDestination, prose, wikiPattern} from './audit-markdown.ts';
import type {ParsedMarkdown} from './audit-markdown.ts';

interface LinkInput {
	location:string;
	mapping?:Mapping;
	files:ReadonlySet<string>;
	notes:ReadonlyMap<string,AuditNote>;
	parsed:(file:string,note:AuditNote)=>ParsedMarkdown;
	readBody:(file:string)=>Promise<string>;
	report:AuditReport;
}
interface Target {file:string; fragment:string}
const outsideAbsolute=(name:string)=>/^(?:\/|[A-Za-z]:)|[\\\0]/u.test(name);
const outside=(file:string)=>file==='..' || file.startsWith('../') || outsideAbsolute(file);
const inside=(file:string,folder:string)=>file.startsWith(folder+'/');
const withExtension=(file:string,files:ReadonlySet<string>)=>!files.has(file) && files.has(file+'.md') ? file+'.md' : file;

// Use virtual, library-relative paths. Never resolve a link against the host
// filesystem or use another library's files to disambiguate a short title.
export function markdownTarget(from:string,url:string,files:ReadonlySet<string>):Target|undefined {
	if((/^[A-Za-z][\w+.-]*:/u.test(url) && !/^[A-Za-z]:[\\/]/u.test(url)) || url.startsWith('//'))return;
	const hash=url.indexOf('#');
	const fragment=decodeURIComponent(hash<0?'':url.slice(hash+1));
	const name=decodeURIComponent((hash<0?url:url.slice(0,hash)).split('?')[0]!);
	const relative=outsideAbsolute(name) ? name : name ? path.join(path.dirname(from),name) : from;
	return {file:withExtension(relative,files),fragment};
}

export function referenceTarget(from:string,value:string,location:string,files:ReadonlySet<string>):string|undefined {
	const wiki=/^\[\[([^\]\n]+)\]\]$/u.exec(value.trim());
	if(wiki){
		const name=wiki[1]!.split(/[|#]/u)[0]!.trim(), full=path.normalize(name);
		if(!outsideAbsolute(name) && inside(full,location))return withExtension(full.slice(location.length+1),files);
		return;
	}
	const destination=inlineDestination(value.trim());
	if(destination!==undefined){
		try{return markdownTarget(from,destination,files)?.file;}catch{return;}
	}
	if(value && !outsideAbsolute(value) && !value.startsWith('[[') && !/^[A-Za-z][\w+.-]*:/u.test(value))
		return path.join(path.dirname(from),value);
	return undefined;
}

function fragments(body:string){
	const headings=new Set<string>(),blocks=new Set<string>();
	for(const line of prose(body).split('\n')){
		const title=/^ {0,3}#{1,6}\s+(.+?)\s*$/u.exec(line)?.[1]?.replace(/\s+#+$/u,'').trim().toLowerCase();
		if(title){
			headings.add(title);
			headings.add(title.replace(/[^\p{L}\p{M}\p{N}_ -]/gu,'').replace(/ /gu,'-'));
		}
		for(const match of line.matchAll(/\^([\p{L}\p{N}_-]+)(?=\s|$)/gu))blocks.add(match[1]!);
	}
	return {headings,blocks};
}

export async function checkLinks({location,mapping,files,notes,parsed,readBody,report}:LinkInput) {
	const byName=new Map<string,string[]>(),anchors=new Map<string,ReturnType<typeof fragments>>();
	for(const file of files){
		const name=path.basename(file),existing=byName.get(name);
		if(existing)existing.push(file);else byName.set(name,[file]);
	}
	for(const [from,note] of notes){
		const body=parsed(from,note);
		const strict=!!mapping && (from===mapping.index || from===mapping.log || inside(from,mapping.reports) || note.metadata.managed_by==='agent');
		const level=strict?'error':'review';
		async function check(target:Target){
			const {file,fragment}=target;
			if(outside(file)){
				report(level,'cross-kb-link',from,tr('链接越出当前库，已跳过 ','Link outside the selected library: ')+file);
				return;
			}
			if(!files.has(file)){
				report(level,'broken-link',from,tr('未找到目标 ','Missing target: ')+file);
				return;
			}
			if(fragment && /\.md$/iu.test(file)){
				let marks=anchors.get(file);
				if(!marks){
					try{
						marks=fragments(notes.get(file)?.body ?? await readBody(file));anchors.set(file,marks);
					}catch{
						report('review','fragment-unverified',from,tr('未能核对标题或块引用 ','Could not check heading or block: ')+file+'#'+fragment);
						return;
					}
				}
				const valid=fragment.startsWith('^') ? marks.blocks.has(fragment.slice(1)) : marks.headings.has(fragment.split('#').pop()!.toLowerCase());
				if(!valid)report(level,'broken-fragment',from,tr('未找到标题或块引用 ','Missing heading or block: ')+file+'#'+fragment);
			}
		}
		for(const {target:url} of body.links){
			let target:Target|undefined;
			try{target=markdownTarget(from,url,files);}catch{
				report(level,'broken-link',from,tr('无效的链接转义 ','Invalid URL encoding: ')+url);continue;
			}
			if(!target)continue;
			await check(target);
		}
		const short=new Set<string>();
		const values=Object.values(note.metadata).flatMap((v:unknown):unknown[]=>Array.isArray(v)?v as unknown[]:[v]).filter((v):v is string=>typeof v==='string');
		for(const match of [body.text,...values].join('\n').matchAll(wikiPattern)){
			const raw=match[1]!.split('|')[0]!.replace(/\\$/u,'').trim();
			const hash=raw.indexOf('#'),name=hash<0?raw:raw.slice(0,hash),fragment=hash<0?'':raw.slice(hash+1);
			let target=from;
			if(name.includes('/') || outsideAbsolute(name)){
				const full=path.normalize(name);
				if(outsideAbsolute(name) || !inside(full,location)){
					report(level,'cross-kb-link',from,tr('Wiki 链接越出当前库 ','Wikilink outside selected library: ')+name);continue;
				}
				target=withExtension(full.slice(location.length+1),files);
			}else if(name){
				if(strict){
					report('error','ambiguous-wikilink',from,tr('知识页链接须含 Vault 相对路径 ','Use a vault-relative wikilink: ')+name);continue;
				}
				short.add(name);
				const matches=byName.get(name) ?? byName.get(name+'.md') ?? [];
				if(!matches.length){report('review','broken-link',from,tr('库内没有同名目标 ','No target in this library: ')+name);continue;}
				if(matches.length>1){report('review','ambiguous-wikilink',from,tr('库内有多个同名目标 ','Multiple targets in this library: ')+name);continue;}
				target=matches[0]!;
			}
			await check({file:target,fragment});
		}
		if(short.size)report('review','human-wikilink-scope',from,tr('短链接仅在本库内核对 ','Short links checked in this library only: ')+[...short].join(', '));
	}
}

export function checkIndex(mapping:Mapping, index:ParsedMarkdown, files:ReadonlySet<string>,
	articles:ReadonlyMap<string,AuditNote>, report:AuditReport) {
	const from=mapping.index, indexed=new Set<string>();
	for(const {target:url} of index.links){
		let target:Target|undefined;
		try{target=markdownTarget(from,url,files);}catch{continue;}
		if(!target)continue;
		if(!inside(target.file,mapping.wiki))report('error','index-scope',from,tr('索引指向 wiki 以外的文件 ','Index target outside wiki: ')+target.file);
		if(indexed.has(target.file))report('error','index-duplicate',from,tr('索引条目重复 ','Duplicate index entry: ')+target.file);
		indexed.add(target.file);
	}
	for(const [file,note] of articles){
		if(file===mapping.overview && note.metadata.status==='empty')continue;
		if(!indexed.has(file))report('error','index-missing',file,tr('知识页未收录于索引 ','Page is absent from the index: ')+mapping.index);
	}
}
