import { tr } from '../i18n.ts';
import { markdownTarget, referenceTarget } from './audit-links.ts';
import type { ParsedMarkdown } from './audit-markdown.ts';
import { validDate } from './audit-notes.ts';
import { within } from './audit-types.ts';
import type { AuditNote, AuditReport } from './audit-types.ts';
import type { Mapping } from './mapping.ts';

export function checkOperations(location:string, mapping:Mapping | undefined, files:ReadonlySet<string>, notes:ReadonlyMap<string,AuditNote>,
	parsed:(file:string,note:AuditNote)=>ParsedMarkdown, report:AuditReport) {
	const noMaterial=new Set<string>();
	const source=(file:string|undefined):file is string => !!file && files.has(file) &&
		(!mapping || within(file,mapping.raw) || !!mapping.clippings && within(file,mapping.clippings));
	for(const [file,{metadata:m}] of notes){
		if(m.type!=='operation' || mapping && !within(file,mapping.wiki))continue;
		const skip=m.operation==='ingest' && typeof m.disposition==='string' && /^No material$/iu.test(m.disposition.trim());
		const sources=Array.isArray(m.sources) ? m.sources.filter((value):value is string=>typeof value==='string') : [];
		if(skip && !sources.length)report('error','log-raw-missing',file,tr('No material 记录缺少来源','No material entry requires a source'));
		for(const value of new Set(sources)){
			const target=referenceTarget(file,value,location,files);
			if(!source(target))report('error','log-raw-invalid',file,(mapping
				? tr('来源未指向本库原文或剪藏 ','Source must point to raw material in this library: ')
				: tr('未能在本库找到该来源 ','Could not find the source in this library: '))+value);
			else if(skip && validDate(m.date))noMaterial.add(target);
		}
		if(Array.isArray(m.related))for(const value of new Set(m.related)){
			if(typeof value!=='string')continue;
			const target=referenceTarget(file,value,location,files);
			if(!target || !/\.md$/iu.test(target) || !files.has(target))
				report('error','log-related-invalid',file,tr('关联项须指向本库 Markdown 文件 ','Related item must point to Markdown in this library: ')+value);
		}
	}
	if(!mapping)return noMaterial;
	const legacy=notes.get(mapping.log);
	if(!legacy)return noMaterial;
	const content=parsed(mapping.log,legacy), lines=content.text.split('\n');
	const links=new Map<number,string[]>();
	for(const {line,target} of content.links){
		if(!/^- Raw:\s*/u.test(lines[line-1]!))continue;
		const values=links.get(line) ?? [];
		values.push(target);
		links.set(line,values);
	}
	for(let i=0;i<lines.length;){
		if(!/^## \[\d{4}-\d{2}-\d{2}\]\s+ingest\s*\|/u.test(lines[i]!)){i++;continue;}
		const start=i++;
		while(i<lines.length && !/^## \[/u.test(lines[i]!))i++;
		if(!lines.slice(start,i).some(line=>/^- Disposition:\s*No material\s*$/iu.test(line)))continue;
		const refs:string[]=[];
		for(let line=start+1;line<=i;line++)refs.push(...links.get(line) ?? []);
		if(!refs.length)report('error','log-raw-missing',mapping.log,tr('No material 记录缺少 Raw 链接','No material entry requires a Raw link'));
		for(const value of refs){
			let target:string|undefined;
			try{target=markdownTarget(mapping.log,value,files)?.file;}catch{/* Report malformed targets below. */}
			if(source(target))noMaterial.add(target);
			else report('error','log-raw-invalid',mapping.log,tr('Raw 链接未指向本库来源文件 ','Raw must point to a source in this library: ')+value);
		}
	}
	return noMaterial;
}
