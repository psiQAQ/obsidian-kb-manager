import {isMap, isScalar, isSeq, LineCounter, parseDocument} from 'yaml';
import {fencedBlocks} from './fences.ts';
import type {BaseExpression} from './types.ts';

// Reports store grouped filters as "and (a, b)". Compare the whole group in
// its recorded scope before highlighting the first condition in current YAML.
function filterSource(node:unknown, depth=0): {text:string; offset:number} | undefined {
	if (isScalar(node) && typeof node.value==='string' && node.range)
		return {text:node.value,offset:node.range[0]};
	if (depth>=32 || !isMap(node) || node.items.length!==1 || !node.range) return;
	const {key,value}=node.items[0]!;
	if (!isScalar(key) || !['and','or','not'].includes(String(key.value)) || !isSeq(value)) return;
	let text=String(key.value)+' (',offset=node.range[0];
	for (const [i,item] of value.items.entries()) {
		const child=filterSource(item,depth+1);
		if (!child) return;
		if (!i) offset=child.offset;
		text+=(i?', ':'')+child.text;
		if (text.length>512) return;
	}
	return {text:text+')',offset};
}

export function baseExpressionLine(source:string,entry:BaseExpression):number|undefined {
	const standalone=entry.file.toLowerCase().endsWith('.base');
	if (standalone && entry.line) return entry.line;
	const blocks=standalone ? [{source,line:0}] :
		fencedBlocks(source,true).filter(block=>block.language==='base' && (!entry.line || block.line===entry.line));
	const matches:number[]=[];
	for (const block of blocks) {
		const counter=new LineCounter();
		const doc=parseDocument(block.source,{lineCounter:counter});
		if (doc.errors.length || !isMap(doc.contents)) continue;
		function match(node:unknown) {
			const value=filterSource(node);
			if (value?.text===entry.expression) matches.push(block.line+counter.linePos(value.offset).line);
		}
		if (['Global filter','全局筛选'].includes(entry.scope)) match(doc.get('filters',true));
		const views=doc.get('views',true);
		if (isSeq(views)) for (const view of views.items) {
			if (!isMap(view)) continue;
			const name=view.get('name');
			const suffix=' · '+(typeof name==='string'?name:'—');
			if (entry.scope==='View filter'+suffix || entry.scope==='视图筛选'+suffix) match(view.get('filters',true));
		}
		for (const field of ['formulas','summaries']) {
			if (entry.scope.startsWith(field+'.')) match(doc.getIn([field,entry.scope.slice(field.length+1)],true));
		}
	}
	return matches.length===1 ? matches[0] : undefined;
}
