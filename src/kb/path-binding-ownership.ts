import {isMap,isScalar,isSeq,parseDocument} from 'yaml';
import {segments} from '../fs/segments.ts';
import {markdownPathDestinations,wikiDestinations} from './audit-markdown.ts';
import {scanBasePaths} from './base-paths.ts';
import {rebind} from './bindings.ts';
import {canvasFileFields} from './canvas-file-fields.ts';
import {readManifest} from './identity-core.ts';
import type {Identity,ManagedFile} from './identity-core.ts';
import {applyRootPatches,rootPatches} from './path-binding-slots.ts';
import {isBuiltinWiki,isKepano} from './template-core.ts';
import {TomlEdits} from './toml-edit.ts';

const markerPrefix='KBMANAGERROOTSLOT';
const marker=(index:number)=>markerPrefix+index+'END';
const markedTarget=/^KBMANAGERROOTSLOT(\d+)END\//u;

function markdownTargets(source:string){
	const opening=/^\uFEFF?---[ \t]*\r?\n/u.exec(source);
	if(!opening)return markdownPathDestinations(source);
	const remaining=source.slice(opening[0].length);
	const closing=/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(remaining);
	if(!closing)return [];
	const document=parseDocument(remaining.slice(0,closing.index));
	const targets=markdownPathDestinations(remaining.slice(closing.index+closing[0].length));
	if(!document.errors.length && isMap(document.contents) && !document.contents.anchor){
		for(const {value} of document.contents.items){
			const values=isSeq(value) && !value.anchor ? value.items : [value];
			for(const item of values){
				if(isScalar(item) && !item.anchor && typeof item.value==='string')targets.push(...wikiDestinations(item.value));
			}
		}
	}
	return targets;
}

function indexedScannerTargets(path:string,source:string,root:string){
	const indexes=new Set<number>();
	function record(target:string,allowRoot:boolean,file=false){
		const match=markedTarget.exec(target);
		if(!match)return;
		const actual=target.slice(match[0].length);
		if(actual===root ? !allowRoot : !actual.startsWith(root+'/'))return;
		if(file && actual.endsWith('/') || /\{\{|<%|__(?:KB_ROOT|WIKI_PATH|NOTES_PATH|WIKI_DIR|TEMPLATES_DIR|CATEGORY_PATH)__/u.test(actual))return;
		try {segments(actual.replace(/\/$/u,''));}
		catch {return;}
		indexes.add(Number(match[1]));
	}
	if(/\.canvas$/iu.test(path)){
		try {for(const {token} of canvasFileFields(source))if(token)record(token.target,false,true);}
		catch { /* Leave invalid Canvas source under its existing protection. */ }
		return indexes;
	}
	const extension=path.toLowerCase().endsWith('.base')?'base':/\.md$/iu.test(path)?'md':undefined;
	if(!extension)return indexes;
	if(extension==='md')for(const target of markdownTargets(source))record(target,false,true);
	for(const {argument,kind} of scanBasePaths(source,extension)){
		if(argument?.start===undefined || kind==='link' && (/[#%|?]/u.test(argument.value) || argument.value.endsWith('/')))continue;
		record(argument.value,kind==='inFolder',kind==='link');
	}
	return indexes;
}

// Offsets are relative to the source with only the remaining owned roots removed.
export function opaqueRootOffsets(path:string,source:string,offsets:readonly number[],root:string):number[]{
	if(!offsets.length || source.includes(markerPrefix) || !/\.(?:md|base|canvas)$/iu.test(path))return [...offsets];
	// Keep the original spelling in the marker probe so an invalid path (for
	// example an unquoted Markdown destination with spaces) stays invalid.
	const patches=rootPatches(source,offsets,root,index=>marker(index)+'/'+root,path);
	const indexed=indexedScannerTargets(path,applyRootPatches(source,patches),root);
	let removed=0;
	return patches.flatMap(({start,end},index)=>{
		if(indexed.has(index))return [];
		const offset=start-removed;
		removed+=end-start;
		return [offset];
	});
}

export function literalRootOffsets(source:string,token:string){
	const offsets:number[]=[];
	for(let at=source.indexOf(token);at>=0;at=source.indexOf(token,at+token.length))offsets.push(at-offsets.length*token.length);
	return offsets;
}

export interface BindingOwnership {opaque?:ManagedFile}

export function provesIndependentBindingAppend(binding:ManagedFile,baseline:string,current:string,opaque:ManagedFile){
	const {path,root,role}=binding;
	if(!root || role!=='template-root' || !/\.md$/iu.test(path) || !current.startsWith(baseline) || baseline===current)return false;
	const suffix=current.slice(baseline.length);
	const leading=/^(?:[ \t]*\r?\n)*/u.exec(suffix)![0];
	const trailing=/(?:\r?\n[ \t]*){0,2}$/u.exec(baseline)![0];
	if(!/\r?\n[ \t]*\r?\n/u.test(trailing+leading))return false;
	const paragraphs=suffix.slice(leading.length);
	// Restrict recovery to plain paragraphs. Appended Markdown definitions,
	// block delimiters, or inline syntax can alter parsing outside the suffix.
	if(!/^[\p{L}\p{N}]/u.test(paragraphs) || /[[\]{}<>`~$%\\]/u.test(paragraphs) || /^(?: {4}|\t| {0,3}(?:[-+*] |\d+[.)] |#|[-=]{2,}\s*$))/mu.test(paragraphs))return false;
	const probe='KBMANAGERAPPENDPROBE/Note';
	if(baseline.includes(probe) || !markdownTargets(baseline+leading+'[['+probe+']]').includes(probe))return false;
	const all=literalRootOffsets(baseline,root);
	if(opaqueRootOffsets(path,baseline,all,root).length===all.length)return false;
	const currentSlots=opaqueRootOffsets(path,current,binding.offsets ?? [],root);
	return currentSlots.length===opaque.offsets?.length && currentSlots.every((offset,index)=>offset===opaque.offsets?.[index]);
}

// The caller supplies only bytes matching the recorded fingerprint. A current
// text match without that provenance cannot prove where old slots came from.
export function classifyPathBinding(binding:ManagedFile,baseline:string,template?:Identity['template']):BindingOwnership|undefined{
	const {path,root,role,offsets}=binding;
	if(!root)return undefined;
	try {
		if(role==='template-root' && offsets){
			const opaque=opaqueRootOffsets(path,baseline,offsets,root);
			return opaque.length ? {opaque:{...binding,offsets:opaque}} : {};
		}
		const overview=path==='knowledge.base' && (role==='overview-bindings' || !role && isBuiltinWiki(template));
		const kepano=role==='kepano-bindings' && isKepano(template) && /\.(?:md|base)$/iu.test(path);
		if(!overview && !kepano || !baseline.includes(root+'/'))return undefined;
		// Old records omit offsets. Only transfer them when every root use in
		// the verifiable original is covered. An opaque use keeps its old role.
		if(overview && rebind(baseline,root,root).manual.length)return undefined;
		const uses=literalRootOffsets(baseline,root);
		return opaqueRootOffsets(path,baseline,uses,root).length ? undefined : {};
	} catch {return undefined;}
}

export function retirePathBindings(raw:string,paths:ReadonlySet<string>){
	if(!paths.size)return raw;
	const {identity}=readManifest(raw);
	const changes=new TomlEdits(raw);
	for(const [index,file] of (identity?.managed ?? []).entries()){
		if(paths.has(file.path))changes.removeArrayItem(['manager','managed',index]);
	}
	const output=changes.finish();
	readManifest(output);
	return output;
}
