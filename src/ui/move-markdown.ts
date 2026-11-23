import { parseLinktext, resolveSubpath } from 'obsidian';
import { posix } from 'node:path';
import type { CachedMetadata, MetadataCache, Pos } from 'obsidian';
import { dynamicTarget } from '../diagnostics/links.ts';
import { key } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { sameOrBelow } from '../registry/paths.ts';
import { markdownReferencePath } from '../kb/move-link-text.ts';
import { keepsRelativeLinkTarget, moveProperties, movePropertyTokens, moveReferenceDefinition, moveReferenceUse, referenceId } from '../kb/move-markdown-paths.ts';
import { affectedByMove, movedMarkdownToken } from '../kb/move-references.ts';
import type { MoveToken, ambiguousWikiMoveTargets } from '../kb/move-references.ts';

interface Scope {source:string;destination:string}
export interface MarkdownMoveField {token:MoveToken;location:string;before:string;after:string}

function annotationOffset(text:string,original:string,position:Pos['start'],starts:readonly number[]) {
	const offset=(starts[position.line] ?? -1)+position.col;
	if (offset>=0 && text.slice(offset,offset+original.length)===original) return offset;
	if (position.line===0 && text.startsWith('\uFEFF') && text.slice(offset+1,offset+1+original.length)===original) return offset+1;
	return undefined;
}

const external=(link:string)=>/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(link);

export function moveLinkParts(link:string, definition=false) {
	const parts=parseLinktext(link);
	if (!definition) return parts;
	try {return {path:decodeURIComponent(parts.path).split('?')[0]!,subpath:decodeURIComponent(parts.subpath)};}
	catch {return parts;}
}

export function knownMarkdownAnchor(metadata: MetadataCache, target: string, subpath:string) {
	if (!subpath || !/\.md$/iu.test(target)) return true;
	if (subpath.startsWith('##')) return false;
	const cache=metadata.getCache(target);
	return !!cache && !!resolveSubpath(cache,subpath);
}

export function markdownMoveFields(metadata:MetadataCache,file:string,text:string,cache:CachedMetadata,scope:Scope,
	manual:(reason:string)=>void,ambiguousTargets:ReturnType<typeof ambiguousWikiMoveTargets>) {
	const inside=sameOrBelow(file,scope.source);
	const properties=moveProperties(text);
	const lines=text.split(/\r?\n/u);
	const starts=[0,...Array.from(text.matchAll(/\n/gu),match=>match.index+1)];
	const fields=new Map<number,MarkdownMoveField>();
	const rejected=new Set<number>();
	const definitions=new Map<string,string>();
	function collect(link:string,where:string,original:string,tokens:(target:string)=>MoveToken[],definition=false) {
		if (external(link)) return;
		const {path,subpath}=moveLinkParts(link,definition);
		const raw=markdownReferencePath(original,definition);
		const target=path ? metadata.getFirstLinkpathDest(path,file)?.path : subpath ? file : undefined;
		const wiki=/^!?\[\[/u.test(original);
		const relative=(value:string)=>posix.normalize(posix.join(posix.dirname(file),value));
		const related=(value:string)=>sameOrBelow(key(/^\.\.?\//u.test(value) ? relative(value) : value.replace(/^\//u,'')),key(scope.source));
		const crosses=target && inside!==sameOrBelow(target,scope.source);
		const ambiguous=wiki ? ambiguousTargets(file,path,target,scope) : [];
		if (!inside && !(target && affectedByMove(file,target,scope)) && !ambiguous.length && !related(raw || path)) return;
		const review=(reason:string)=>manual(where+' · '+original+' · '+reason);
		if (dynamicTarget(link) || subpath.startsWith('##')) {
			review(tr('检查动态或搜索链接','Review this dynamic or search link'));
			return;
		}
		if (ambiguous.length) {review(tr('同名候选','Same-name candidates')+' → '+ambiguous.join(', '));return;}
		if (!target) {review(tr('无法解析目标','The target does not resolve'));return;}
		if (!knownMarkdownAnchor(metadata,target,subpath)) {
			review(tr('无法确认标题、块或脚注锚点','Could not verify the heading, block or footnote anchor')+' → '+target+subpath);
			return;
		}
		const candidates=tokens(target);
		if (!candidates.length) {
			review(tr('原文与链接缓存不一致，或无法定位该字段','The link cache differs from the saved contents, or this field could not be located'));
			return;
		}
		if (raw && /^(?:\.\.?\/|\/)/u.test(raw)) {
			const expected=raw.startsWith('/') ? raw.slice(1) : relative(raw);
			if (expected!==target && expected+'.md'!==target) {
				review(tr('链接拼写与索引解析的目标不一致','The link spelling differs from the indexed target')+' → '+target);
				return;
			}
		}
		if (raw && (!wiki && !raw.startsWith('/') || /^\.\.?\//u.test(raw)) && keepsRelativeLinkTarget(raw,file,target,scope)) return;
		for (const token of candidates) {
			const after=movedMarkdownToken(token,file,scope);
			if (after===undefined) {review(tr('检查此链接格式','Review this link syntax'));continue;}
			if (after===original) {
				if (crosses && wiki && raw && !raw.startsWith('/') && ambiguousTargets(file,path,target,scope,true).length)
					review(tr('跨库或库外目标在移动后可能变化','The target outside the moving library may change after the move')+' → '+target);
				continue;
			}
			const existing=fields.get(token.offset);
			if (existing && JSON.stringify(existing.token)!==JSON.stringify(token)) {
				fields.delete(token.offset);rejected.add(token.offset);
				review(tr('链接范围重叠','Link ranges overlap'));
			}
			const location=crosses ? where+' · '+tr('跨库或库外目标','Target outside the moving library')+' · '+target : where;
			if (!rejected.has(token.offset)) fields.set(token.offset,{token,location,before:original,after});
		}
	}
	for (const ref of cache.frontmatterLinks ?? [])
		collect(ref.link,tr('属性','Property')+' '+ref.key,ref.original,target=>movePropertyTokens(properties,ref.key,ref.original,target));
	for (const ref of cache.referenceLinks ?? []) {
		const line=ref.position.start.line;
		const original=moveReferenceDefinition(lines,ref.id,ref.position,ref.link);
		if (original) definitions.set(referenceId(ref.id),ref.link);
		collect(ref.link,tr('引用定义','Reference definition')+' '+ref.id+' · '+tr('行','Line')+' '+(line+1),
			original ?? lines[line]?.trim() ?? ref.link,target=>original && starts[line]!==undefined ? [{
				offset:starts[line]+Number(line===0 && text.startsWith('\uFEFF')),original,target,definition:true,
			}] : [],true);
	}
	for (const ref of [...(cache.links ?? []),...(cache.embeds ?? [])]) {
		const definition=moveReferenceUse(ref.original,ref.displayText ?? '');
		if (definition && definitions.has(definition)) continue;
		collect(ref.link,tr('行','Line')+' '+(ref.position.start.line+1),ref.original,target=>{
			const offset=annotationOffset(text,ref.original,ref.position.start,starts);
			return offset===undefined ? [] : [{offset,original:ref.original,target}];
		});
	}
	return [...fields.values()].sort((a,b)=>a.token.offset-b.token.offset);
}
