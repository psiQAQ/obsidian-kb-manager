import { isMap, parseDocument, stringify } from 'yaml';
import { tr } from '../i18n.ts';

function splitHeader(text: string) {
	const start = /^(?:\uFEFF)?---[ \t]*\r?\n/u.exec(text);
	if (!start) return { header:'', end:0, body:text, keys:new Map<string,unknown>() };
	const end = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(text.slice(start[0].length));
	if (!end) throw new Error(tr('属性缺少结束标记','Missing properties closing delimiter'));
	const header = text.slice(start[0].length,start[0].length + end.index);
	const doc = parseDocument(header,{uniqueKeys:true});
	if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new Error(tr('属性格式无效','Invalid note properties'));
	const keys:unknown = doc.toJS({mapAsMap:true});
	if (keys && (!(keys instanceof Map) || [...keys.keys()].some(key=>typeof key!=='string'))) throw new Error(tr('属性名须为文本','Property names must be text'));
	const offset = start[0].length + end.index + end[0].length;
	return {header,end:offset,body:text.slice(offset),keys:new Map<string,unknown>(keys instanceof Map ? keys : [])};
}

export function insertTemplate(note:string, template:string, cursor:number, title:string, format:(kind:string,pattern?:string)=>string) {
	const rendered = template.replace(/\{\{(title|date|time)(?::([^}\n]+))?\}\}/gu,(_,kind:string,pattern?:string)=>kind==='title'?title:format(kind,pattern));
	const existing=splitHeader(note), incoming=splitHeader(rendered);
	const missing = new Map<string,unknown>(), conflicts:string[]=[];
	for(const [name,value] of incoming.keys){
		if (!existing.keys.has(name)) missing.set(name,value);
		else if (stringify(existing.keys.get(name))!==stringify(value)) conflicts.push(name);
	}
	const eol=note.includes('\r\n')?'\r\n':'\n';
	let prefix=note.slice(0,existing.end);
	if(missing.size){
		const fields=stringify(missing).replace(/\r?\n/gu,eol);
		if(existing.end) {
			const cut=prefix.indexOf('\n')+1+existing.header.length;
			prefix=prefix.slice(0,cut)+fields+prefix.slice(cut);
		}
		else prefix='---'+eol+fields+'---'+eol;
	}
	const offset=Math.max(existing.end,Math.min(cursor,note.length));
	if(existing.end && !prefix.endsWith('\n') && incoming.body) prefix+=eol;
	const before=prefix+note.slice(existing.end,offset);
	return {text:before+incoming.body+note.slice(offset),cursor:before.length+incoming.body.length,conflicts};
}
