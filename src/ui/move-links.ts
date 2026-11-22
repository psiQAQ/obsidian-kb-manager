import { parseLinktext } from 'obsidian';
import type { CachedMetadata, LinkCache, Reference, TFile, Vault } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { tr } from '../i18n.ts';
import { overlaps } from '../fs/vault.ts';
import { compareRegistryPaths, sameOrBelow } from '../registry/paths.ts';
import { discover } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { managedBaseFile, moveBaseFields } from '../kb/move-base-paths.ts';
import type { MoveBaseField } from '../kb/move-base-paths.ts';
import { canvasMoveTargets, moveVaultPath, relocateMarkdownReference } from '../kb/move-link-text.ts';
import { affectedByMove, ambiguousWikiMoveTargets, assertWritableOwner, baseMoveTokens, readMoveReference, referenceEdit, referenceOwner } from '../kb/move-references.ts';
import type { MoveLinks, MoveToken, ReferenceEdit } from '../kb/move-references.ts';
import type { MoveRecord } from '../kb/move.ts';
import { dialogContents } from './dialog.ts';

interface ReferenceFile {
	file: string;
	owner?: Library;
	text: string;
	links?: MoveLinks;
	baseFields: MoveBaseField[];
}
interface ReferenceGroup { path: string; label: string; files: ReferenceFile[] }
interface ReferencePlan { groups: ReferenceGroup[]; review: string[] }

function annotationOffset(text: string, original: string, position: LinkCache['position']['start']) {
	const matches=(offset:number)=>text.slice(offset,offset+original.length)===original;
	if (matches(position.offset)) return position.offset;
	// Cached offsets can use a normalized line ending. Verify the original token
	// against its line and column before accepting a position in the disk text.
	let start=0;
	for (let line=0;line<position.line;line++) {
		const next=text.indexOf('\n',start);
		if (next===-1) return undefined;
		start=next+1;
	}
	const offset=start+position.col;
	return matches(offset) ? offset : undefined;
}

function markdownLinkDrafts(plugin: KnowledgeBaseManager, file: TFile, cache: CachedMetadata | null, plan: MoveRecord, review: (reason:string)=>void,
	ambiguousTargets: ReturnType<typeof ambiguousWikiMoveTargets>) {
	const {metadataCache}=plugin.app;
	if (!cache) {
		if (sameOrBelow(file.path,plan.source) || Object.keys(metadataCache.resolvedLinks[file.path] ?? {})
			.some(target=>sameOrBelow(target,plan.source))) review(tr('缓存未就绪','Metadata cache is not ready'));
		return [];
	}
	const hasAffectedTarget=(ref: Pick<Reference,'link'>) => {
		const path=parseLinktext(ref.link).path;
		if (!path) return;
		const target=metadataCache.getFirstLinkpathDest(path,file.path)?.path;
		return target && affectedByMove(file.path,target,plan) ? target : undefined;
	};
	if ([...(cache.frontmatterLinks ?? []),...(cache.referenceLinks ?? [])].some(hasAffectedTarget))
		review(tr('检查属性或引用式链接','Review property or reference-style links'));
	const links=[...(cache.links ?? []),...(cache.embeds ?? [])];
	const drafts=[];
	for (const ref of links) {
		const path=parseLinktext(ref.link).path;
		if (!path) continue;
		const target=metadataCache.getFirstLinkpathDest(path,file.path)?.path;
		if (/^!?\[\[/u.test(ref.original)) {
			const ambiguous=ambiguousTargets(file.path,path,target,plan);
			if (ambiguous.length) {
				review(tr('同名候选需要人工核对：','Review an ambiguous wikilink: ')+path+' → '+ambiguous.join(', '));
				continue;
			}
		}
		if (!target || !affectedByMove(file.path,target,plan)) {
			if (!target && sameOrBelow(path.replace(/^\//u,''),plan.source))
				review(tr('检查无法解析的旧路径','Review unresolved references to the original path'));
			continue;
		}
		const replacement=relocateMarkdownReference(ref.original,file.path,target,plan.source,plan.destination);
		if (replacement===undefined) review(tr('检查此链接格式','Review this link syntax'));
		else if (replacement!==ref.original) drafts.push({ref,target});
	}
	return drafts;
}

function markdownEdits(text: string, drafts: ReturnType<typeof markdownLinkDrafts>, review: (reason:string)=>void): MoveLinks | undefined {
	if (!drafts.length) return;
	const tokens=new Map<number,MoveToken>();
	for (const {ref,target} of drafts) {
		const offset=annotationOffset(text,ref.original,ref.position.start);
		if (offset===undefined) {
			review(tr('正文与链接缓存不一致，请保存并等待重新索引','The link cache differs from the note. Save and wait for it to be indexed.'));
			return;
		}
		const previous=tokens.get(offset);
		if (previous && (previous.original!==ref.original || previous.target!==target)) {
			review(tr('链接范围重叠','Link ranges overlap'));
			return;
		}
		tokens.set(offset,{offset,original:ref.original,target});
	}
	return {kind:'markdown',tokens:[...tokens.values()].sort((a,b)=>b.offset-a.offset)};
}

function canvasEdits(plugin: KnowledgeBaseManager, text: string, plan: MoveRecord, review: (reason:string)=>void): MoveLinks | undefined {
	const targets=canvasMoveTargets(text,plan.source,plan.destination).filter(target=>{
		if (plugin.app.vault.getFileByPath(target)) return true;
		review(tr('检查缺失的 Canvas 文件节点：','Review missing Canvas file node: ')+target);
		return false;
	});
	if (targets.length) return {kind:'canvas',targets};
	return undefined;
}

export async function planMoveReferences(plugin: KnowledgeBaseManager, plan: MoveRecord,
	only?: ReadonlySet<string>): Promise<ReferencePlan> {
	const libraries=await discover(plugin.disk,plugin.config);
	const groups=new Map<string,ReferenceGroup>(), review=new Set<string>(), permissions=new Map<string,Promise<void>>();
	const files=plugin.app.vault.getFiles();
	const ambiguousTargets=ambiguousWikiMoveTargets(function* () {for (const file of files) yield file.path;});
	const candidates=files.filter(file=>(!only || only.has(file.path)) && ['md','canvas','base'].includes(file.extension.toLowerCase())
		&& !plugin.config.templates.some(template=>overlaps(file.path,template)));
	candidates.sort((a,b)=>compareRegistryPaths(a.path,b.path));
	for (const file of candidates) {
		const owner=referenceOwner(libraries,file.path), path=owner?.location ?? '';
		const label=owner?.identity?.displayName ?? owner?.location ?? tr('Vault 未登记区域','Unregistered Vault files');
		const manual=(reason:string)=>review.add(label+' · '+file.path+' · '+reason);
		try {
			const extension=file.extension.toLowerCase();
			const cache=extension==='md' ? plugin.app.metadataCache.getFileCache(file) : null;
			const inlineBase=extension==='md' && (cache?.sections?.some(section=>['code','base'].includes(section.type)) ??
				sameOrBelow(file.path,plan.source));
			const drafts=extension==='md' ? markdownLinkDrafts(plugin,file,cache,plan,manual,ambiguousTargets) : [];
			if (extension==='md' && !inlineBase && !drafts.length) continue;
			const text=await readMoveReference(plugin.disk,file.path);
			const base=extension==='base' || extension==='md' ? moveBaseFields(text,file.path,plan,managedBaseFile(owner,file.path)) : undefined;
			for (const issue of base?.manual ?? []) manual(issue);
			const links=extension==='canvas' ? canvasEdits(plugin,text,plan,manual) : markdownEdits(text,drafts,manual);
			const baseFields=base?.fields ?? [];
			if (!links && !baseFields.length) continue;
			if (sameOrBelow(file.path,plan.source) && plan.changes.some(change=>plan.source+'/'+change.file===file.path)) {
				manual(tr('此文件同时有受管绑定更新，请在移动后核对引用','A managed binding also updates this file. Review its references after moving.'));
				continue;
			}
			if (owner && path!==plan.source) {
				let permission=permissions.get(path);
				if (!permission) {
					permission=assertWritableOwner(plugin.disk,owner);
					permissions.set(path,permission);
				}
				await permission;
			}
			let group=groups.get(path);
			if (!group) {
				group={path,label,files:[]};
				groups.set(path,group);
			}
			group.files.push({file:file.path,owner,text,links,baseFields});
		} catch (error) { manual(String(error)); }
	}
	return {groups:[...groups.values()],review:[...review]};
}

function selectReferenceFile(plan: MoveRecord, draft: ReferenceFile, links: boolean, offsets?: ReadonlySet<number>) {
	const base=draft.baseFields.filter(field=>offsets?.has(field.token.offset)).map(field=>field.token);
	const ordinary=links ? draft.links : undefined;
	if (!base.length) return ordinary && referenceEdit(draft.file,draft.owner,draft.text,plan,ordinary);
	const references:ReferenceEdit['references']=draft.file.toLowerCase().endsWith('.base') ?
		{kind:'base',base} : {kind:'markdown',tokens:ordinary?.kind==='markdown' ? ordinary.tokens : [],base};
	return referenceEdit(draft.file,draft.owner,draft.text,plan,references);
}

export async function moveReferencesMatch(plugin: KnowledgeBaseManager, plan: MoveRecord, selected: readonly ReferenceEdit[]) {
	const latest=await planMoveReferences(plugin,plan,new Set(selected.map(edit=>edit.file)));
	const byPath=new Map(latest.groups.flatMap(group=>group.files.map(draft=>[draft.file,draft] as const)));
	return selected.every(edit=>{
		const draft=byPath.get(edit.file);
		if (!draft) return false;
		const links=edit.references.kind==='canvas' || edit.references.kind==='markdown' && edit.references.tokens.length>0;
		const offsets=new Set(baseMoveTokens(edit.references).map(token=>token.offset));
		try { return JSON.stringify(selectReferenceFile(plan,draft,links,offsets))===JSON.stringify(edit); }
		catch { return false; }
	});
}

export function selectMoveReferences(parent: HTMLElement, vault: Vault, plan: MoveRecord, referencePlan: ReferencePlan) {
	const auto=(vault as Vault & {getConfig?(key:string):unknown}).getConfig?.('alwaysUpdateLinks')===true;
	const selected=new Set<string>(), selectedBase=new Map<string,Set<number>>();
	const linkGroups=referencePlan.groups.filter(group=>group.files.some(file=>file.links));
	if (linkGroups.length) {
		parent.createEl('h3',{text:tr('可更新的引用','References that can be updated')});
		parent.createEl('p',{text:tr('选择要更新的文件。跨库和未登记区域的更改需要单独勾选。',
			'Select the files to update. Select changes in other libraries and unregistered folders separately.')});
		for (const group of linkGroups) {
			const files=group.files.filter(file=>file.links);
			const title=group.path && group.path!==group.label ? group.label+' · '+group.path : group.label;
			const header=parent.createEl('label',{cls:'kb-move-reference-group'});
			const all=header.createEl('input',{type:'checkbox',attr:{'aria-label':title}});
			header.createSpan({text:title+' ('+files.length+')'});
			const details=parent.createEl('details',{cls:'kb-v3-detail'});
			details.createEl('summary',{text:tr('查看文件','Review files')});
			const controls=files.map(edit=>{
				const row=details.createDiv().createEl('label');
				const input=row.createEl('input',{type:'checkbox',attr:{'aria-label':edit.file}});
				row.createSpan({text:edit.file});
				return {input,file:edit.file};
			});
			const choose=(file:string, checked:boolean)=>checked ? selected.add(file) : selected.delete(file);
			const update=()=>{
				const count=controls.filter(row=>row.input.checked).length;
				all.checked=count===controls.length;
				all.indeterminate=count>0 && count<controls.length;
			};
			for (const {input,file} of controls) {
				input.checked=auto && group.path===plan.source;
				choose(file,input.checked);
				input.addEventListener('change',()=>{choose(file,input.checked);update();});
			}
			all.addEventListener('change',()=>{
				for (const {input,file} of controls) {input.checked=all.checked;choose(file,all.checked);}
				update();
			});
			update();
		}
	}
	const baseGroups=referencePlan.groups.filter(group=>group.files.some(file=>file.baseFields.length));
	if (baseGroups.length) {
		parent.createEl('h3',{text:tr('可选的 Base 路径更新','Optional Base path updates')});
		parent.createEl('p',{text:tr('逐项勾选要更新的 Base 路径。所有路径默认不勾选。','Select each Base path to update. All paths start unchecked.')});
		for (const group of baseGroups) {
			for (const draft of group.files.filter(file=>file.baseFields.length)) {
				const details=parent.createEl('details',{cls:'kb-v3-detail'});
				details.createEl('summary',{text:group.label+' · '+draft.file+' ('+draft.baseFields.length+')'});
				const offsets=new Set<number>();
				selectedBase.set(draft.file,offsets);
				for (const field of draft.baseFields) {
					const row=details.createDiv().createEl('label');
					const input=row.createEl('input',{type:'checkbox',attr:{
						'data-base-file':draft.file,'data-base-field':field.field,'data-base-path':field.before,
					}});
					row.createSpan({text:field.location+' · '+field.before+' → '+field.after});
					input.addEventListener('change',()=>{
						if (input.checked) offsets.add(field.token.offset);
						else offsets.delete(field.token.offset);
					});
				}
			}
		}
	}
	if (referencePlan.review.length) {
		const review=parent.createEl('details',{cls:'kb-v3-detail'});
		review.createEl('summary',{text:tr('需人工核对的引用','References for manual review')+' ('+referencePlan.review.length+')'});
		dialogContents(review).lines(referencePlan.review);
	}
	parent.createEl('p',{text:tr('预览会检查 Base 文件、已索引的 Markdown 代码块及所选库中尚未索引的笔记。外部剪藏、脚本与动态查询需人工核对。',
		'The preview checks Base files, indexed Markdown code blocks and unindexed notes in the moving library. Review external clippings, scripts and dynamic queries manually.')});
	return ()=>referencePlan.groups.flatMap(group=>group.files.flatMap(draft=>{
		const edit=selectReferenceFile(plan,draft,selected.has(draft.file),selectedBase.get(draft.file));
		return edit ? [edit] : [];
	}));
}

export async function verifyMoveReferences(plugin: KnowledgeBaseManager, record: MoveRecord) {
	const {vault,metadataCache}=plugin.app;
	const movedPath=(file:string)=>moveVaultPath(file,record.source,record.destination);
	const expected=(record.references ?? []).flatMap(edit=>edit.references.kind==='markdown' ? [{
		file:movedPath(edit.file),
		tokens:edit.references.tokens.map(token=>({
			original:relocateMarkdownReference(token.original,edit.file,token.target,record.source,record.destination),
			target:movedPath(token.target),
		})),
	}] : []);
	const unresolved=()=>expected.flatMap(({file,tokens})=>{
		const note=vault.getFileByPath(file);
		const cache=note ? metadataCache.getFileCache(note) : undefined;
		const refs=[...(cache?.links ?? []),...(cache?.embeds ?? [])];
		return tokens.filter(token=>!refs.some(ref=>ref.original===token.original &&
			metadataCache.getFirstLinkpathDest(parseLinktext(ref.link).path,file)?.path===token.target))
			.map(token=>file+' → '+token.target);
	});
	const remaining=unresolved();
	if (!remaining.length) return remaining;
	return new Promise<string[]>(resolve=>{
		const finish=(links:string[])=>{
			window.clearTimeout(timer);
			metadataCache.offref(event);
			resolve([...new Set(links)]);
		};
		const event=metadataCache.on('resolved',()=>{
			if (!unresolved().length) finish([]);
		});
		const timer=window.setTimeout(()=>finish(unresolved()),1800);
	});
}
