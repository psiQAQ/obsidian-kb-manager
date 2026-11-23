import {parseDocument,visit} from 'yaml';
import {tr} from '../i18n.ts';
import {validateKepanoRoot} from './kepano.ts';

export function singleQuotedScalars(source:string){
	const doc=parseDocument(source);
	if(doc.errors.length)throw new Error(doc.errors[0]?.message);
	const scalars: {start:number;end:number;value:string}[]=[];
	visit(doc,{Scalar(_,node){
		if(node.type==='QUOTE_SINGLE' && node.range && typeof node.value==='string')
			scalars.push({start:node.range[0],end:node.range[1],value:node.value});
	}});
	return scalars;
}

export interface RootPatch {start:number;end:number;replacement:string}

export function rootPatches(source:string, offsets:readonly number[], previous:string, destination:string | ((index:number)=>string), file:string){
	if(typeof destination==='string')validateKepanoRoot(destination);
	const quoted=file.toLowerCase().endsWith('.base') && (previous.includes("'") || typeof destination==='string' && destination.includes("'"))
		? singleQuotedScalars(source):[];
	let cursor=0, rootLength=0;
	return offsets.map((offset,index):RootPatch=>{
		const start=offset+rootLength;
		const singleQuoted=quoted.some(range=>start>=range.start && start<range.end);
		const old=singleQuoted?previous.replaceAll("'","''"):previous;
		if(start<cursor || source.slice(start,start+old.length)!==old)
			throw new Error(tr('声明的位置与文件内容不符，需人工核对','Declared positions differ from file contents. Review manually.'));
		const next=typeof destination==='string'?destination:destination(index);
		cursor=start+old.length;
		rootLength+=old.length;
		return {start,end:cursor,replacement:singleQuoted?next.replaceAll("'","''"):next};
	});
}

export function applyRootPatches(source:string,patches:readonly RootPatch[]){
	let cursor=0, content='';
	for(const {start,end,replacement} of patches){
		content+=source.slice(cursor,start)+replacement;
		cursor=end;
	}
	return content+source.slice(cursor);
}
