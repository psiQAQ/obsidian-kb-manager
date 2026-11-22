import {tr} from '../i18n.ts';
import {builtinAttributesFile} from '../git/markdown-attributes.ts';
import {instanceText} from './instance-text.ts';
import type {Template,Variables} from './template-core.ts';
import type {Declaration} from './template-declaration.ts';

export interface PackDescriptor extends Declaration {
	id:string; version:string; name:string; description:string; purpose:string; entry:string;
}
interface Pack {descriptor:PackDescriptor; text:Record<string,string>; binary:Record<string,string>; folders:string[]}
declare const KB_TEMPLATE_PACKS:Record<string,Pack>;
declare const KB_CHECK_DIGESTS:string[];
const catalog:Record<string,Pack>=typeof KB_TEMPLATE_PACKS==='undefined'?{}:KB_TEMPLATE_PACKS;
export function builtinPacks():PackDescriptor[] {return Object.values(catalog).map(pack=>pack.descriptor);}
export function officialCheckDigests():string[]{return typeof KB_CHECK_DIGESTS==='undefined'?[]:KB_CHECK_DIGESTS;}
export function builtinSource(id:string){return id==='llm-wiki'?'':'builtin:'+id;}
export function packText(id:string):Record<string,string>{return catalog[id]?.text??{};}

export function renderPack(id:string,vars:Variables):Template {
	const pack=catalog[id];
	if(!pack)throw new Error(tr('找不到内置模板：','Unknown built-in template: ')+id);
	const {descriptor}=pack;
	const rootSlots:Record<string,number[]>={};
	const files=Object.entries(pack.text).map(([name,source])=>{
		const fields=descriptor.text?.[name];
		if(fields){
			const rendered=instanceText(name,source,fields,vars);
			source=rendered.content;
			if(rendered.offsets.length)rootSlots[name]=rendered.offsets;
		}
		return {name,bytes:new TextEncoder().encode(source)};
	});
	for(const [name,encoded] of Object.entries(pack.binary))
		files.push({name,bytes:Uint8Array.from(atob(encoded),letter=>letter.charCodeAt(0))});
	if(!files.some(file=>file.name==='.gitattributes'))files.push(builtinAttributesFile());
	return {id,paths:descriptor.paths,version:descriptor.version,entry:descriptor.entry,files,folders:[...pack.folders],rootSlots,excluded:[],
		suggestedExcludedFolders:descriptor.suggestedExcludedFolders,managedFiles:descriptor.managedFiles};
}
