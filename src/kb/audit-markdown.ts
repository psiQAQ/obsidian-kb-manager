// Bounded Markdown and evidence rules ported from the Vault's read-only checker.
// Literal candidate rules derive from Astro-Han/karpathy-llm-wiki (MIT).
export interface MarkdownLink {target:string; label:string; line:number}
export interface ParsedMarkdown {text:string; visible:string; links:MarkdownLink[]}
export interface Candidate {kind:'date'|'number'|'quote'; value:string}

const whitespace = (s:string)=>s.replace(/\s+/gu,' ').trim();
const labelKey = (s:string)=>whitespace(s).toUpperCase().toLowerCase();
const newlines = (s:string)=>s.replace(/[^\n]/gu,'');
const destination = (s:string)=>s.startsWith('<') && s.endsWith('>') ? s.slice(1,-1) : s;
const definition = /^ {0,3}\[([^[\]\n]+)\]:[ \t]*(<[^<>\n]*>|[^\s<>]+?)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/gmu;
const linkPattern = /!?\[([^[\]\n]*)\](?:\([ \t]*(<[^<>\n]*>|[^\s()]+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\)|\[([^[\]\n]*)\])/gu;
export const wikiPattern = /!?\[\[([^\]\n]+)\]\]/gu;

// Keep line positions for log records and link findings. Pair equal-length
// backtick runs only; an unmatched run remains ordinary visible text.
function removeCodeSpans(paragraph:string) {
	const runs=Array.from(paragraph.matchAll(/`+/gu));
	const next=new Map<number,number>(),closing:number[]=[];
	for(let i=runs.length-1;i>=0;i--){
		const length=runs[i]![0].length;
		closing[i]=next.get(length) ?? -1;
		next.set(length,i);
	}
	let start=0, result='';
	for(let i=0;i<runs.length;i++){
		const j=closing[i]!;
		if(j<0)continue;
		const open=runs[i]!.index,last=runs[j]!;
		const end=last.index+last[0].length;
		result+=paragraph.slice(start,open)+newlines(paragraph.slice(open,end));
		start=end;i=j;
	}
	return result+paragraph.slice(start);
}

export function prose(body:string) {
	let fence='';
	const lines=body.replace(/\r\n?/gu,'\n').split('\n').map(line=>{
		const marker=/^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if(fence){
			if(marker && marker[1]![0]===fence[0] && marker[1]!.length>=fence.length && !marker[2]!.trim())fence='';
			return '';
		}
		if(marker && !(marker[1]![0]==='`' && marker[2]!.includes('`'))){
			fence=marker[1]!;return '';
		}
		return line;
	});
	const uncommented=lines.join('\n').replace(/<!--[\s\S]*?(?:-->|$)/gu,newlines);
	return uncommented.split(/(\n[ \t]*\n)/u).map(removeCodeSpans).join('');
}

export function parseMarkdown(body:string):ParsedMarkdown {
	const definitions=new Map<string,string>();
	const text=prose(body).replace(definition,(_match:string,label:string,url:string)=>{
		const key=labelKey(label);
		if(!definitions.has(key))definitions.set(key,destination(url));
		return '';
	});
	const links:MarkdownLink[]=[];
	const visible=text.split('\n').map((line,i)=>line.replace(linkPattern,
		(original:string,label:string,url:string|undefined,ref:string|undefined)=>{
			const target=url===undefined ? definitions.get(labelKey(ref || label)) : destination(url);
			if(target===undefined)return original;
			links.push({target,label,line:i+1});return label;
		})).join('\n').replace(wikiPattern,(_match:string,inside:string)=>inside.split('|').pop()!)
		.replace(/\b(?:https?|ftp):\/\/[^\s<>"\]]+/giu,'');
	return {text,visible,links};
}

export function candidates(body:string):Candidate[]{
	const text=parseMarkdown(body).visible;
	const found=new Map<string,Candidate>();
	const add=(kind:Candidate['kind'],value:string)=>{found.set(kind+' '+value,{kind,value});};
	for(const line of text.split('\n')){
		const remaining=line.replace(/\d{4}-\d{2}(?:-\d{2})?/gu,date=>{add('date',date);return ' ';});
		for(const [value] of remaining.matchAll(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)*(?:\s*[KMB%](?![A-Za-z]))?(?![A-Za-z])/gu)){
			if(/[KMB%.,]/u.test(value) || value.length>=4)add('number',value);
		}
	}
	for(const paragraph of text.split(/\n\s*\n/u)){
		for(const match of whitespace(paragraph).matchAll(/"([^"]*)"|“([^”]*)”/gu)){
			const quote=(match[1] ?? match[2]!).trim();
			if(Array.from(quote).length>=15)add('quote',quote);
		}
	}
	let block:string[]=[];
	for(const line of [...text.split('\n'),'']){
		if(/^\s*>/u.test(line))block.push(line.replace(/^\s*>+\s*/u,''));
		else if(block.length){
			const quote=whitespace(block.join(' '));
			if(Array.from(quote).length>=15)add('quote',quote);
			block=[];
		}
	}
	return [...found.values()];
}

const escapeRegExp=(s:string)=>s.replace(/[.*+?^$`{}()|[\]\\]/gu,'\\$&');

export function contains(text:string,candidate:Candidate){
	const value=whitespace(candidate.value),haystack=whitespace(text);
	if(candidate.kind==='quote')return haystack.includes(value);
	const boundary=candidate.kind==='date' && value.length===7 ? '(?!-\\d{2})' : '';
	return new RegExp('(?<![\\d.,])'+escapeRegExp(value)+boundary+'(?![A-Za-z0-9]|[.,]\\d|%)','u').test(haystack);
}

export function sourceBody(body:string) {
	// Legacy imported sources may have bookkeeping immediately after the H1.
	// Strip that block, while retaining matching lines in the actual prose.
	const lines=body.split(/\r?\n/u),head=lines.findIndex(s=>s.startsWith('# '));
	if(head>=0){
		let i=head+1;
		while(i<lines.length && !lines[i]!.trim())i++;
		while(i<lines.length && /^>\s*(?:Source|Collected|Published):/u.test(lines[i]!))lines[i++]='';
	}
	return parseMarkdown(lines.join('\n')).visible;
}
