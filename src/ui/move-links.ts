import type { Vault } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { tr } from '../i18n.ts';
import { digest, key, overlaps } from '../fs/vault.ts';
import { compareRegistryPaths, sameOrBelow } from '../registry/paths.ts';
import { discover } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { markdownPathDestinations } from '../kb/audit-markdown.ts';
import { classifyLibraryBinding } from '../kb/maintenance.ts';
import type { Repair } from '../kb/maintenance.ts';
import { moveBaseFields } from '../kb/move-base-paths.ts';
import type { MoveBaseField } from '../kb/move-base-paths.ts';
import { canvasFileFields, moveVaultPath } from '../kb/move-link-text.ts';
import { ambiguousWikiMoveTargets, assertWritableOwner, baseMoveTokens, managedReferenceDisposition, markdownReferencePatch,
	movedMarkdownToken, readMoveReference, referenceEdit, referenceOwner } from '../kb/move-references.ts';
import type { MoveToken, ReferenceEdit } from '../kb/move-references.ts';
import type { MoveRecord } from '../kb/move.ts';
import { dialogContents } from './dialog.ts';
import { hasUnsavedMoveEditor, openMoveEditors, saveMoveEditorMessage } from './move-editors.ts';
import { knownMarkdownAnchor, markdownMoveFields, moveLinkParts } from './move-markdown.ts';
import type { MarkdownMoveField } from './move-markdown.ts';

interface ReferenceFile {
	file: string;
	owner?: Library;
	text: string;
	managed?: Repair;
	links: MarkdownMoveField[];
	baseFields: MoveBaseField[];
}
interface ReferenceGroup { path: string; label: string; files: ReferenceFile[] }
interface ReferencePlan { groups: ReferenceGroup[]; review: string[] }

function canvasEdits(plugin: KnowledgeBaseManager, file:string, text: string, plan: MoveRecord, review: (reason:string)=>void) {
	const fields:MarkdownMoveField[]=[];
	for (const {field,id,token} of canvasFileFields(text)) {
		const where=field+(id ? ' · '+id : '');
		if (!token) {
			if (sameOrBelow(file,plan.source)) review(where+' · '+tr('文件节点没有有效路径','The file node lacks a valid path'));
			continue;
		}
		const before=token.target, after=moveVaultPath(before,plan.source,plan.destination);
		if (before===after) {
			if (sameOrBelow(key(before.replace(/^\//u,'')),key(plan.source)))
				review(where+' · '+before+' · '+tr('检查 Canvas 文件路径拼写','Review the Canvas file path spelling'));
			continue;
		}
		if (!plugin.app.vault.getFileByPath(before)) {
			review(where+' · '+tr('检查缺失的 Canvas 文件节点：','Review missing Canvas file node: ')+before);
			continue;
		}
		fields.push({token,location:where,before,after});
	}
	return fields;
}

export async function planMoveReferences(plugin: KnowledgeBaseManager, plan: MoveRecord,
	only?: ReadonlySet<string>): Promise<ReferencePlan> {
	const libraries=await discover(plugin.disk,plugin.config);
	const groups=new Map<string,ReferenceGroup>(), review=new Set<string>(), permissions=new Map<string,Promise<void>>();
	const files=plugin.app.vault.getFiles();
	const editors=openMoveEditors(plugin);
	const changes=new Map(plan.changes.map(change=>[plan.source+'/'+change.file,change]));
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
			const metadata=plugin.app.metadataCache;
			const cache=extension==='md' ? metadata.getFileCache(file) : null;
			const managed=changes.get(file.path), open=editors.get(file);
			const indexedFields=cache && (cache.frontmatterLinks?.length || cache.referenceLinks?.length || cache.links?.length ||
				cache.embeds?.length || cache.sections?.some(section=>['code','base'].includes(section.type)));
			if (cache && !indexedFields && !managed && !open) continue;
			const text=await readMoveReference(plugin.disk,file.path);
			const inside=sameOrBelow(file.path,plan.source);
			if (extension==='md' && !cache) {
				const inSource=(target:string)=>sameOrBelow(target,plan.source);
				if (inside || text.includes(plan.source) || Object.keys(metadata.resolvedLinks[file.path] ?? {}).some(inSource) ||
					markdownPathDestinations(text).some(link=>{
						const target=metadata.getFirstLinkpathDest(link,file.path)?.path;
						return target && inSource(target) || ambiguousTargets(file.path,link,target,plan).length>0;
					})) manual(tr('缓存未就绪','Metadata cache is not ready'));
			}
			const unsaved=!!open && hasUnsavedMoveEditor(text,open);
			if (unsaved) {manual(saveMoveEditorMessage());continue;}
			const binding=owner?.identity?.managed.find(item=>key(owner.location+'/'+item.path)===key(file.path));
			const classification=binding && owner && !managed ? await classifyLibraryBinding(plugin.disk,owner,binding,text,plugin.kepanoSkeleton) : undefined;
			const ordinary=!binding || (managed ? !!managed.patches?.length && digest(text)===managed.before : !!classification && !classification.opaque);
			const consideredManaged=!!binding || !!managed;
			const after=managed && digest(text)===managed.before ? managed.after : undefined;
			const base=extension==='base' || extension==='md' ? moveBaseFields(text,file.path,plan,consideredManaged,after,ordinary) : undefined;
			for (const issue of base?.manual ?? []) manual(issue);
			const overlap=tr('此引用与受管范围重叠，请人工核对','This reference overlaps a managed field. Review it manually');
			const allowed=(patch:Parameters<typeof managedReferenceDisposition>[0],location:string,before:string)=>{
				const disposition=after && managed ? managedReferenceDisposition(patch,managed) : 'ordinary';
				if (disposition==='covered') return false;
				if (!ordinary || disposition==='review') {manual(location+' · '+before+' · '+overlap);return false;}
				return true;
			};
			const links=(extension==='canvas' ? canvasEdits(plugin,file.path,text,plan,manual) : cache ?
				markdownMoveFields(metadata,file.path,text,cache,plan,manual,ambiguousTargets) : []).filter(field=>{
				try {
					const patch=extension==='canvas' ? {...field.token,replacement:JSON.stringify(field.after)} :
						markdownReferencePatch(text,file.path,plan,field.token);
					if (!allowed(patch,field.location,field.before)) return false;
					if (field.token.property) referenceEdit(file.path,owner,text,plan,{kind:'markdown',tokens:[field.token]},managed);
					return true;
				} catch {manual(field.location+' · '+field.before+' · '+tr('此字段无法安全更新','This field cannot be updated safely'));return false;}
			});
			const baseFields=(base?.fields ?? []).filter(field=>{
				if (!allowed({...field.token,replacement:field.replacement},field.location,field.before)) return false;
				if (!field.link) return true;
				const {path,subpath}=field.link;
				const targets=[path,path+'.md'].filter(target=>plugin.app.vault.getFileByPath(target));
				if (targets.length===1 && !ambiguousTargets(file.path,path,targets[0],plan).length && knownMarkdownAnchor(metadata,targets[0]!,subpath)) return true;
				manual(field.location+' · '+field.before+' · '+tr('无法确认 Base 链接的目标或锚点','Could not verify the Base link target or anchor'));
				return false;
			});
			if (!links.length && !baseFields.length) continue;
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
			group.files.push({file:file.path,owner,text,managed,links,baseFields});
		} catch (error) { manual(String(error)); }
	}
	return {groups:[...groups.values()],review:[...review]};
}

function selectReferenceFile(plan: MoveRecord, draft: ReferenceFile, offsets: ReadonlySet<number>, baseOffsets: ReadonlySet<number>) {
	const base=draft.baseFields.filter(field=>baseOffsets.has(field.token.offset)).map(field=>field.token);
	const tokens=draft.links.filter(field=>offsets.has(field.token.offset)).map(field=>field.token);
	if (!base.length && !tokens.length) return;
	const references:ReferenceEdit['references']=draft.file.toLowerCase().endsWith('.base') ? {kind:'base',base} :
		draft.file.toLowerCase().endsWith('.canvas') ? {kind:'canvas-fields',tokens} :
			{kind:'markdown',tokens,...(base.length ? {base} : {})};
	return referenceEdit(draft.file,draft.owner,draft.text,plan,references,draft.managed);
}

export async function moveReferencesMatch(plugin: KnowledgeBaseManager, plan: MoveRecord, selected: readonly ReferenceEdit[]) {
	const latest=await planMoveReferences(plugin,plan,new Set(selected.map(edit=>edit.file)));
	const byPath=new Map(latest.groups.flatMap(group=>group.files.map(draft=>[draft.file,draft] as const)));
	return selected.every(edit=>{
		const draft=byPath.get(edit.file);
		if (!draft) return false;
		const offsets=new Set('tokens' in edit.references ? edit.references.tokens.map(token=>token.offset) : []);
		const baseOffsets=new Set(baseMoveTokens(edit.references).map(token=>token.offset));
		try { return JSON.stringify(selectReferenceFile(plan,draft,offsets,baseOffsets))===JSON.stringify(edit); }
		catch { return false; }
	});
}

function checkboxGroup(input:HTMLInputElement, children:HTMLInputElement[], changed?:()=>void) {
	const update=()=>{
		input.checked=children.every(child=>child.checked);
		input.indeterminate=!input.checked && children.some(child=>child.checked || child.indeterminate);
		changed?.();
	};
	input.addEventListener('change',()=>{
		const checked=input.checked;
		for (const child of children) {
			child.checked=checked;
			child.dispatchEvent(new Event('change'));
		}
	});
	for (const child of children) child.addEventListener('change',update);
	update();
	return update;
}

export function selectMoveReferences(parent: HTMLElement, vault: Vault, plan: MoveRecord, referencePlan: ReferencePlan) {
	const auto=(vault as Vault & {getConfig?(key:string):unknown}).getConfig?.('alwaysUpdateLinks')===true;
	const selected=new Map<string,Set<number>>(), selectedBase=new Map<string,Set<number>>();
	const linkGroups=referencePlan.groups.filter(group=>group.files.some(file=>file.links.length));
	if (linkGroups.length) {
		parent.createEl('h3',{text:tr('可更新的引用','References that can be updated')});
		parent.createEl('p',{text:tr('选择要更新的引用。跨库和未登记区域的更改需要单独勾选。',
			'Select the references to update. Select changes in other libraries and unregistered folders separately.')});
		for (const group of linkGroups) {
			const files=group.files.filter(file=>file.links.length);
			const title=group.path && group.path!==group.label ? group.label+' · '+group.path : group.label;
			const header=parent.createEl('label',{cls:'kb-move-reference-group'});
			const all=header.createEl('input',{type:'checkbox',attr:{'aria-label':title}});
			header.createSpan({text:title+' ('+files.length+')'});
			const details=parent.createEl('details',{cls:'kb-v3-detail'});
			details.createEl('summary',{text:tr('查看文件','Review files')});
			let updateGroup:(()=>void)|undefined;
			const fileControls=files.map(draft=>{
				const offsets=new Set<number>();
				selected.set(draft.file,offsets);
				const file=details.createEl('details',{cls:'kb-v3-detail'});
				const row=file.createEl('summary').createEl('label');
				const input=row.createEl('input',{type:'checkbox',attr:{'aria-label':draft.file}});
				row.createSpan({text:draft.file+' ('+draft.links.length+')'});
				const fields=draft.links.map(field=>{
					const row=file.createDiv().createEl('label');
					const control=row.createEl('input',{type:'checkbox',attr:{
						'data-reference-file':draft.file,'data-reference-field':field.location,'data-reference-before':field.before,
					}});
					row.createSpan({text:field.location+' · '+field.before+' → '+field.after});
					control.checked=auto && group.path===plan.source;
					if (control.checked) offsets.add(field.token.offset);
					control.addEventListener('change',()=>control.checked ? offsets.add(field.token.offset) : offsets.delete(field.token.offset));
					return control;
				});
				checkboxGroup(input,fields,()=>updateGroup?.());
				return input;
			});
			updateGroup=checkboxGroup(all,fileControls);
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
		const detail=parent.createEl('details',{cls:'kb-v3-detail',attr:{'data-move-reference-section':'manual'}});
		detail.createEl('summary',{text:tr('需人工核对的引用','References for manual review')+' ('+referencePlan.review.length+')'});
		dialogContents(detail).lines(referencePlan.review);
	}
	parent.createEl('p',{text:tr('预览检查索引中的 Markdown 引用、Base 路径和 Canvas 文件节点。外部剪藏、脚本与动态查询需人工核对。',
		'The preview checks indexed Markdown references, Base paths and Canvas file nodes. Review external clippings, scripts and dynamic queries manually.')});
	return ()=>referencePlan.groups.flatMap(group=>group.files.flatMap(draft=>{
		const edit=selectReferenceFile(plan,draft,selected.get(draft.file) ?? new Set(),selectedBase.get(draft.file) ?? new Set());
		return edit ? [edit] : [];
	}));
}

export async function verifyMoveReferences(plugin: KnowledgeBaseManager, record: MoveRecord) {
	const {vault,metadataCache}=plugin.app;
	const movedPath=(file:string)=>moveVaultPath(file,record.source,record.destination);
	const expected=(record.references ?? []).flatMap(edit=>edit.references.kind==='markdown' ? [{
		file:movedPath(edit.file),
		tokens:edit.references.tokens.map(token=>({token,original:movedMarkdownToken(token,edit.file,record),target:movedPath(token.target)})),
	}] : []);
	const matches=(ref:{link:string},file:string,target:string,token:MoveToken)=>{
		const {path,subpath}=moveLinkParts(ref.link,token.definition);
		return metadataCache.getFirstLinkpathDest(path,file)?.path===target && knownMarkdownAnchor(metadataCache,target,subpath);
	};
	const unresolved=()=>expected.flatMap(({file,tokens})=>{
		const note=vault.getFileByPath(file);
		const cache=note ? metadataCache.getFileCache(note) : undefined;
		return tokens.filter(({token,original,target})=>{
			if (token.definition) {
				const id=/^ {0,3}\[([^\]]+)\]:/u.exec(token.original)?.[1];
				return !cache?.referenceLinks?.some(ref=>ref.id===id && matches(ref,file,target,token));
			}
			if (token.property) return !cache?.frontmatterLinks?.some(ref=>ref.key===token.property?.key && ref.original===original && matches(ref,file,target,token));
			return ![...(cache?.links ?? []),...(cache?.embeds ?? [])].some(ref=>ref.original===original && matches(ref,file,target,token));
		}).map(token=>file+' → '+token.target);
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
