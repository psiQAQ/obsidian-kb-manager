import { parseLinktext } from 'obsidian';
import type { LinkCache, Reference, TFile, Vault } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { tr } from '../i18n.ts';
import { overlaps } from '../fs/vault.ts';
import { compareRegistryPaths, sameOrBelow } from '../registry/paths.ts';
import { discover } from '../kb/catalog.ts';
import { canvasMoveTargets, moveVaultPath, relocateMarkdownReference } from '../kb/move-link-text.ts';
import { affectedByMove, assertWritableOwner, readMoveReference, referenceEdit, referenceOwner } from '../kb/move-references.ts';
import type { MoveToken, ReferenceEdit } from '../kb/move-references.ts';
import type { MoveRecord } from '../kb/move.ts';
import { dialogContents } from './dialog.ts';

interface ReferenceGroup { path: string; label: string; files: ReferenceEdit[] }
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

async function markdownEdits(plugin: KnowledgeBaseManager, file: TFile, plan: MoveRecord, review: (reason:string)=>void) {
	const {metadataCache}=plugin.app;
	const cache=metadataCache.getFileCache(file);
	if (!cache) {
		if (sameOrBelow(file.path,plan.source) || Object.keys(metadataCache.resolvedLinks[file.path] ?? {})
			.some(target=>sameOrBelow(target,plan.source))) review(tr('缓存未就绪','Metadata cache is not ready'));
		return;
	}
	const targetOf=(ref: Pick<Reference,'link'>) => {
		const path=parseLinktext(ref.link).path;
		if (!path) return;
		const target=metadataCache.getFirstLinkpathDest(path,file.path)?.path;
		return target && affectedByMove(file.path,target,plan) ? target : undefined;
	};
	if ([...(cache.frontmatterLinks ?? []),...(cache.referenceLinks ?? [])].some(ref=>targetOf(ref)))
		review(tr('检查属性或引用式链接','Review property or reference-style links'));
	const links=[...(cache.links ?? []),...(cache.embeds ?? [])];
	const drafts=[];
	for (const ref of links) {
		const target=targetOf(ref);
		if (!target) {
			const path=parseLinktext(ref.link).path.replace(/^\//u,'');
			if (sameOrBelow(path,plan.source)) review(tr('检查无法解析的旧路径','Review unresolved references to the original path'));
			continue;
		}
		const replacement=relocateMarkdownReference(ref.original,file.path,target,plan.source,plan.destination);
		if (replacement===undefined) review(tr('检查此链接格式','Review this link syntax'));
		else if (replacement!==ref.original) drafts.push({ref,target});
	}
	if (!drafts.length) return;
	const text=await readMoveReference(plugin.disk,file.path);
	const tokens=new Map<number,MoveToken>();
	for (const {ref,target} of drafts) {
		const offset=annotationOffset(text,ref.original,ref.position.start);
		if (offset===undefined) throw new Error(tr('正文与链接缓存不一致，请保存并等待重新索引','The link cache differs from the note. Save and wait for it to be indexed.'));
		const previous=tokens.get(offset);
		if (previous && (previous.original!==ref.original || previous.target!==target)) throw new Error(tr('链接范围重叠','Link ranges overlap'));
		tokens.set(offset,{offset,original:ref.original,target});
	}
	return {text,references:{kind:'markdown' as const,tokens:[...tokens.values()].sort((a,b)=>b.offset-a.offset)}};
}

async function canvasEdits(plugin: KnowledgeBaseManager, file: TFile, plan: MoveRecord, review: (reason:string)=>void) {
	const text=await readMoveReference(plugin.disk,file.path);
	const targets=canvasMoveTargets(text,plan.source,plan.destination).filter(target=>{
		if (plugin.app.vault.getFileByPath(target)) return true;
		review(tr('检查缺失的 Canvas 文件节点：','Review missing Canvas file node: ')+target);
		return false;
	});
	if (targets.length) return {text,references:{kind:'canvas' as const,targets}};
	return undefined;
}

export async function planMoveReferences(plugin: KnowledgeBaseManager, plan: MoveRecord): Promise<ReferencePlan> {
	const libraries=await discover(plugin.disk,plugin.config);
	const groups=new Map<string,ReferenceGroup>(), review=new Set<string>(), permissions=new Map<string,Promise<void>>();
	const candidates=plugin.app.vault.getFiles().filter(file=>['md','canvas'].includes(file.extension.toLowerCase())
		&& !plugin.config.templates.some(template=>overlaps(file.path,template)));
	candidates.sort((a,b)=>compareRegistryPaths(a.path,b.path));
	for (const file of candidates) {
		const owner=referenceOwner(libraries,file.path), path=owner?.location ?? '';
		const label=owner?.identity?.displayName ?? owner?.location ?? tr('Vault 未登记区域','Unregistered Vault files');
		const manual=(reason:string)=>review.add(label+' · '+file.path+' · '+reason);
		try {
			const edit=await (file.extension.toLowerCase()==='canvas' ? canvasEdits : markdownEdits)(plugin,file,plan,manual);
			if (!edit) continue;
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
			const planned=referenceEdit(file.path,owner,edit.text,plan,edit.references);
			let group=groups.get(path);
			if (!group) {
				group={path,label,files:[]};
				groups.set(path,group);
			}
			group.files.push(planned);
		} catch (error) { manual(String(error)); }
	}
	return {groups:[...groups.values()],review:[...review]};
}

export function selectMoveReferences(parent: HTMLElement, vault: Vault, plan: MoveRecord, referencePlan: ReferencePlan) {
	const auto=(vault as Vault & {getConfig?(key:string):unknown}).getConfig?.('alwaysUpdateLinks')===true;
	const selected=new Set<string>();
	if (referencePlan.groups.length) {
		parent.createEl('h3',{text:tr('可更新的引用','References that can be updated')});
		parent.createEl('p',{text:tr('选择要更新的文件。跨库和未登记区域的更改需要单独勾选。',
			'Select the files to update. Select changes in other libraries and unregistered folders separately.')});
		for (const group of referencePlan.groups) {
			const title=group.path && group.path!==group.label ? group.label+' · '+group.path : group.label;
			const header=parent.createEl('label',{cls:'kb-move-reference-group'});
			const all=header.createEl('input',{type:'checkbox',attr:{'aria-label':title}});
			header.createSpan({text:title+' ('+group.files.length+')'});
			const details=parent.createEl('details',{cls:'kb-v3-detail'});
			details.createEl('summary',{text:tr('查看文件','Review files')});
			const controls=group.files.map(edit=>{
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
	if (referencePlan.review.length) {
		const review=parent.createEl('details',{cls:'kb-v3-detail'});
		review.createEl('summary',{text:tr('需人工核对的引用','References for manual review')+' ('+referencePlan.review.length+')'});
		dialogContents(review).lines(referencePlan.review);
	}
	parent.createEl('p',{text:tr('外部剪藏、脚本与动态查询需人工核对。','Review external clippings, scripts and dynamic queries manually.')});
	return ()=>referencePlan.groups.flatMap(group=>group.files.filter(edit=>selected.has(edit.file)));
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
