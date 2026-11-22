import {parseDocument,visit} from 'yaml';
import {tr} from '../i18n.ts';
import {validateKepanoRoot} from './kepano.ts';
import type {Variables} from './template-core.ts';

function singleQuotedScalars(source:string){
	const doc=parseDocument(source);
	if(doc.errors.length)throw new Error(doc.errors[0]?.message);
	const scalars: {start:number;end:number;value:string}[]=[];
	visit(doc,{Scalar(_,node){
		if(node.type==='QUOTE_SINGLE' && node.range && typeof node.value==='string')
			scalars.push({start:node.range[0],end:node.range[1],value:node.value});
	}});
	return scalars;
}

export function instanceText(file:string, source:string, fields:readonly string[], vars:Variables) {
	const offsets:number[]=[];
	const bindRoot=fields.includes('kb_root');
	if(bindRoot)validateKepanoRoot(vars.destination);
	if(bindRoot && file.endsWith('.base') && source.includes('{{kb_root}}')){
		const scalars=singleQuotedScalars(source);
		if(vars.destination.includes("'")){
			// Obsidian saves these scalars double-quoted once their value has an apostrophe.
			for(const {start,end,value} of scalars.sort((a,b)=>b.start-a.start)){
				if(value.includes('{{kb_root}}'))source=source.slice(0,start)+JSON.stringify(value)+source.slice(end);
			}
		}
	}
	let cursor=0, content='';
	for(const hit of source.matchAll(/\{\{(kb_name|description|kb_root)\}\}/gu)){
		const name=hit[1]!;
		if(!fields.includes(name))continue;
		content+=source.slice(cursor,hit.index);
		if(name==='kb_root'){
			offsets.push(content.length-offsets.length*vars.destination.length);
			content+=vars.destination;
		}else content+=name==='kb_name'?vars.displayName:vars.description;
		cursor=hit.index+hit[0].length;
	}
	return {content:content+source.slice(cursor),offsets};
}

export function rebindSlots(source:string, offsets:readonly number[], previous:string, destination:string, file='') {
	validateKepanoRoot(destination);
	const quoted=file.endsWith('.base') && (previous.includes("'") || destination.includes("'"))?singleQuotedScalars(source):[];
	let cursor=0, content='', rootLength=0;
	for(const offset of offsets){
		const start=offset+rootLength;
		const singleQuoted=quoted.some(range=>start>=range.start && start<range.end);
		const old=singleQuoted?previous.replaceAll("'","''"):previous;
		if(start<cursor || source.slice(start,start+old.length)!==old)
			throw new Error(tr('声明的位置与文件内容不符，需人工核对','Declared positions differ from file contents. Review manually.'));
		content+=source.slice(cursor,start)+(singleQuoted?destination.replaceAll("'","''"):destination);
		cursor=start+old.length;
		rootLength+=old.length;
	}
	return content+source.slice(cursor);
}
