import {posix} from 'node:path';
import {isMap, isNode, isScalar, isSeq, parseDocument} from 'yaml';
import type {Node} from 'yaml';
import type {Pos} from 'obsidian';
import {moveVaultPath} from './move-link-text.ts';
import type {MoveToken} from './move-references.ts';

interface Scope { source: string; destination: string }

function exactTarget(path: string, target: string) {
	return path===target || path+'.md'===target;
}

export function keepsRelativeLinkTarget(path: string, from: string, target: string, scope: Scope) {
	if (!path || /[\\]/u.test(path)) return false;
	const relativeTo=(file:string)=>posix.normalize(posix.join(posix.dirname(file),path));
	const moved=(file:string)=>moveVaultPath(file,scope.source,scope.destination);
	return exactTarget(relativeTo(from),target) && exactTarget(relativeTo(moved(from)),moved(target));
}

export function moveProperties(text: string) {
	const header=/^\uFEFF?---[ \t]*\r?\n/u.exec(text);
	if (!header) return;
	const body=text.slice(header[0].length);
	const end=/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(body);
	if (!end) return;
	const yaml=parseDocument(body.slice(0,end.index));
	if (yaml.errors.length) return;
	const bodyStart=header[0].length;
	const fields=new Map<string,{value:string; offset:number; raw:string; encode:(value:string)=>string}|undefined>();
	function walk(node:Node, key:string) {
		if ('anchor' in node && node.anchor || node.tag) return;
		if (isMap(node)) {
			for (const pair of node.items) {
				if (!isScalar(pair.key) || typeof pair.key.value!=='string' || !isNode(pair.value)) continue;
				walk(pair.value,key ? key+'.'+pair.key.value : pair.key.value);
			}
		} else if (isSeq(node)) {
			for (const [index,item] of node.items.entries()) if (isNode(item)) walk(item,key+'.'+index);
		} else if (isScalar(node) && node.range && typeof node.value==='string') {
			const [start,end]=node.range;
			const encode=node.type==='QUOTE_SINGLE' ? (value:string)=>value.replaceAll("'","''") :
				node.type==='QUOTE_DOUBLE' ? (value:string)=>JSON.stringify(value).slice(1,-1) : (value:string)=>value;
			fields.set(key,fields.has(key) ? undefined : {
				value:node.value,offset:bodyStart+start,raw:body.slice(start,end),encode,
			});
		}
	}
	if (yaml.contents) walk(yaml.contents,'');
	return fields;
}

export function movePropertyTokens(properties: ReturnType<typeof moveProperties>, key:string, original:string, target:string): MoveToken[] {
	const property=properties?.get(key);
	if (!property || !/^\[\[[^\r\n]*\]\]$/u.test(original)) return [];
	const raw=property.encode(original);
	const occurrences=(text:string, token:string)=>{
		const offsets:number[]=[];
		for (let start=0; ; ) {
			const index=text.indexOf(token,start);
			if (index===-1) return offsets;
			offsets.push(index);
			start=index+token.length;
		}
	};
	const offsets=occurrences(property.raw,raw);
	if (offsets.length!==occurrences(property.value,original).length) return [];
	return offsets.map(offset=>({offset:property.offset+offset,original:raw,target,property:{key,link:original}}));
}

export const referenceId=(id:string)=>id.trim().replace(/\s+/gu,' ').toUpperCase().toLowerCase();

export function moveReferenceDefinition(lines: readonly string[], id: string, position: Pos, link: string) {
	const line=lines[position.start.line]?.replace(/^\uFEFF/u,'');
	if (!line) return;
	const match=/^ {0,3}\[((?:[^\]\\\r\n]|\\.)+)\]:[ \t]*(?:<([^>\r\n]+)>|([^\s]+))/u.exec(line);
	if (!match || referenceId(match[1]!)!==referenceId(id)) return;
	const value=(match[2] ?? match[3])!;
	try {
		if (value===link || decodeURIComponent(value.replace(/\\([()\\])/gu,'$1'))===link) return match[0];
	} catch { /* Require an unambiguous, decodable destination. */ }
	return undefined;
}

export function moveReferenceUse(original: string, displayText: string) {
	const match=/^!?\[((?:[^[\]\\]|\\.)+)\](?:\[([^[\]\\]*)\])?$/u.exec(original);
	return match ? referenceId(match[2] || displayText || match[1]!) : undefined;
}
