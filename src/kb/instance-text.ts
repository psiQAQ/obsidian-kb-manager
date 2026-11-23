import {validateKepanoRoot} from './kepano.ts';
import {opaqueRootOffsets} from './path-binding-ownership.ts';
import {applyRootPatches,rootPatches,singleQuotedScalars} from './path-binding-slots.ts';
import type {Variables} from './template-core.ts';

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
	content+=source.slice(cursor);
	return {content,offsets:opaqueRootOffsets(file,content,offsets,vars.destination)};
}

export function rebindSlots(source:string, offsets:readonly number[], previous:string, destination:string, file='') {
	return applyRootPatches(source,rootPatches(source,offsets,previous,destination,file));
}
