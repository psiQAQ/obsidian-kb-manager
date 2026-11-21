import { parse, stringify } from 'smol-toml';
import { tr } from '../i18n.ts';

type Address = (string|number)[];
type Value = string|number|boolean|string[];
interface Assignment { address:Address; start:number; end:number; lineStart:number; lineEnd:number; comment:number }
interface Edit { start:number; end:number; content:string }

const key = (path:Address) => JSON.stringify(path);
const quoted = String.raw`(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[A-Za-z0-9_-]+)`;
const dotted = `${quoted}(?:[ \\t]*\\.[ \\t]*${quoted})*`;
const header = new RegExp(String.raw`^(\[\[?)\s*(${dotted})[ \t]*\]\]?[^\n]*`, 'u');
const assignment = new RegExp(String.raw`^(${dotted})[ \t]*=[ \t]*`, 'u');

function components(name:string) {
	// Decode quoted and dotted keys with the same grammar used for validation.
	const path:string[]=[];
	let cursor:unknown=parse(name+' = true');
	while (cursor && typeof cursor==='object') {
		const [part] = Object.keys(cursor);
		if (part===undefined) break;
		path.push(part);
		cursor=(cursor as Record<string,unknown>)[part];
	}
	return path;
}

function valueEnd(raw:string, start:number) {
	let quote='', depth=0, i=start;
	for (;i<raw.length;i++) {
		const char=raw[i]!;
		if (quote) {
			if (char==='\\' && quote[0]==='"') i++;
			else if (raw.startsWith(quote,i)) {
				i+=quote.length-1;
				if (quote.length===3) while(raw[i+1]===char) i++;
				quote='';
			}
		} else if (char==='"' || char==="'") {
			quote=raw.startsWith(char.repeat(3),i)?char.repeat(3):char;
			i+=quote.length-1;
		} else if (char==='[' || char==='{') depth++;
		else if (char===']' || char==='}') depth--;
		else if (char==='#') {
			if(depth===0)break;
			const end=raw.indexOf('\n',i);
			i=end===-1?raw.length:end;
		} else if ((char==='\r' || char==='\n') && depth===0) break;
	}
	return i;
}

function tableIndex(raw:string) {
	const values:Assignment[]=[], ends=new Map<string,number>(), arrays=new Map<string,number>();
	let path:Address=[], offset=raw.startsWith('\uFEFF')?1:0;
	while(offset<raw.length){
		const lineStart=offset;
		while(raw[offset]===' ' || raw[offset]==='\t')offset++;
		const rest=raw.slice(offset);
		const section=header.exec(rest);
		const field=assignment.exec(rest);
		if(section){
			ends.set(key(path),lineStart);
			const parts=components(section[2]!);
			path=[];
			for(const part of parts){
				path.push(part);
				const address=key(path);
				if(section[1]==='[[' && path.filter(p=>typeof p==='string').length===parts.length)
					arrays.set(address,(arrays.get(address)??-1)+1);
				const index=arrays.get(address);
				if(index!==undefined)path.push(index);
			}
		} else if(field) {
			const start=offset+field[0].length, stop=valueEnd(raw,start);
			const end=start+raw.slice(start,stop).trimEnd().length;
			offset=stop;
			const newline=raw.indexOf('\n',offset);
			values.push({address:[...path,...components(field[1]!)],start,end,lineStart,lineEnd:newline===-1?raw.length:newline+1,
				comment:raw[stop]==='#'?stop:-1});
		}
		const newline=raw.indexOf('\n',offset);
		offset=newline===-1?raw.length:newline+1;
	}
	ends.set(key(path),raw.length);
	return {values,ends};
}

const encode = (field:Value) => stringify({v:field}).slice(4).trimEnd();
const formatKey = (field:string) => /^[A-Za-z0-9_-]+$/u.test(field)?field:encode(field);

/** Use validated TOML addresses to replace only the source spans owned by the manager. */
export class TomlEdits {
	readonly newline:string;
	private readonly raw:string;
	private readonly index:ReturnType<typeof tableIndex>;
	private readonly edits:Edit[]=[];
	private readonly insertions=new Map<number,string>();

	constructor(raw:string) {
		this.raw=raw;
		this.newline=raw.includes('\r\n')?'\r\n':'\n';
		this.index=tableIndex(raw);
	}

	field(table:Address, field:string, value:Value|undefined) {
		const path=[...table,field];
		const current=this.index.values.find(item=>key(item.address)===key(path));
		if (current) {
			if (value!==undefined) this.edits.push({start:current.start,end:current.end,content:encode(value)});
			else this.edits.push({start:current.lineStart,end:current.comment===-1?current.lineEnd:current.comment,content:''});
			return;
		}
		const end=this.index.ends.get(key(table));
		if(value===undefined || end===undefined)
			throw new Error(tr('请将待更新字段写在常规 TOML 表中：','Put this field in a regular TOML table before editing: ')+path.join('.'));
		this.insert(end,formatKey(field)+' = '+encode(value)+this.newline);
	}

	append(section:string) {
		const start=this.raw.length;
		const previous=this.raw+(this.insertions.get(start)??'');
		const separator=!previous || previous==='\uFEFF'?'':previous.endsWith('\n')?this.newline:this.newline.repeat(2);
		this.insert(start,separator+section.replace(/\n/gu,this.newline));
	}

	private insert(offset:number,text:string) {
		const previous=this.insertions.get(offset)??'';
		const prefix=offset===this.raw.length && !previous && offset>0 && this.raw[offset-1]!=='\n' && !text.startsWith(this.newline)
			&& this.raw!=='\uFEFF'?this.newline:'';
		this.insertions.set(offset,previous+prefix+text);
	}

	finish() {
		let result=this.raw;
		const insertions=[...this.insertions].map(([start,content])=>({start,end:start,content}));
		for(const edit of [...this.edits,...insertions].sort((a,b)=>b.start-a.start || b.end-a.end)) {
			result=result.slice(0,edit.start)+edit.content+result.slice(edit.end);
		}
		return result;
	}
}
