import {isScalar,parseDocument,visit} from 'yaml';
import {tr} from '../i18n.ts';
import {validateKepanoRoot} from './kepano.ts';
import type {Variables} from './template-core.ts';

export function instanceText(file:string, source:string, fields:readonly string[], vars:Variables) {
	const offsets:number[]=[];
	if(fields.includes('kb_root')){
		validateKepanoRoot(vars.destination);
		if(file.endsWith('.base') && source.includes('{{kb_root}}')){
			const doc=parseDocument(source);
			if(doc.errors.length)throw new Error(doc.errors[0]?.message);
			visit(doc,{Scalar(_,node){
				if(isScalar(node) && typeof node.value==='string' && node.value.includes('{{kb_root}}'))node.type='QUOTE_DOUBLE';
			}});
			source=doc.toString({lineWidth:0});
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

export function rebindSlots(source:string, offsets:readonly number[], previous:string, destination:string) {
	validateKepanoRoot(destination);
	let cursor=0, content='';
	for(const [index,offset] of offsets.entries()){
		const start=offset+index*previous.length;
		if(start<cursor || source.slice(start,start+previous.length)!==previous)
			throw new Error(tr('声明的位置与文件内容不符，需人工核对','Declared positions differ from file contents. Review manually.'));
		content+=source.slice(cursor,start)+destination;
		cursor=start+previous.length;
	}
	return content+source.slice(cursor);
}
