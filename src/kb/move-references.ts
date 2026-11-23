import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tr } from '../i18n.ts';
import { linkCandidateIndex } from '../diagnostics/links.ts';
import { readRelative } from '../diagnostics/snapshot.ts';
import { existingDirectory } from '../fs/paths.ts';
import { digest, key, overlaps, statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { guardGit } from '../git/guard.ts';
import { compareRegistryPaths, sameOrBelow } from '../registry/paths.ts';
import type { Config, Library } from './catalog.ts';
import { moveBaseFields } from './move-base-paths.ts';
import type { MoveBaseToken } from './move-base-paths.ts';
import { canvasFileFields, moveVaultPath, relocateCanvasReferences, relocateMarkdownReference } from './move-link-text.ts';
import { classifyLibraryBinding } from './maintenance.ts';
import type { Repair } from './maintenance.ts';
import { moveProperties, movePropertyTokens } from './move-markdown-paths.ts';

interface Scope { source: string; destination: string }
interface Owner { id: string; location: string }
export interface MoveToken {
	offset: number; original: string; target: string;
	definition?: true;
	property?: {key:string; link:string};
}
export type MoveLinks = { kind: 'markdown'; tokens: MoveToken[]; base?: MoveBaseToken[] } |
	{ kind: 'canvas'; targets: string[] } | { kind:'canvas-fields'; tokens: MoveToken[] };
export interface ReferenceEdit {
	file: string;
	owner: Owner | null;
	before: string;
	result: string;
	bindingOffsets?: number[];
	references: MoveLinks | { kind: 'base'; base: MoveBaseToken[] };
}

export function baseMoveTokens(references: ReferenceEdit['references']) {
	return references.kind==='base' || references.kind==='markdown' ? references.base ?? [] : [];
}

export function referenceTargets(references: ReferenceEdit['references']) {
	return references.kind==='canvas' ? references.targets : references.kind==='base' ? [] : references.tokens.map(token=>token.target);
}

export function affectedByMove(file: string, target: string, scope: Scope): boolean {
	return sameOrBelow(file,scope.source) || sameOrBelow(target,scope.source);
}

export function ambiguousWikiMoveTargets(paths: () => Iterable<string>) {
	const lookup=linkCandidateIndex(paths);
	return (file:string, link:string, resolved:string|undefined, scope:Scope, strict=false) => {
		if (!link || /^(?:\/|\.\.?\/)/u.test(link)) return [];
		const candidates=new Set(lookup({source:file,target:link,kind:'link',syntax:'wiki'}));
		if (resolved) candidates.add(resolved);
		if (candidates.size<2 || ![...candidates].some(target=>affectedByMove(file,target,scope))) return [];
		if (!strict && link.includes('/')) {
			const literal=key(link);
			const exact=[...candidates].filter(candidate=>{
				const normalized=key(candidate);
				return normalized===literal || normalized.replace(/\.md$/u,'')===literal;
			});
			// A complete Vault path can also be the tail of a deeper file path.
			if (exact.length===1 && (!resolved || exact[0]===resolved)) return [];
		}
		return [...candidates].sort(compareRegistryPaths);
	};
}

export function referenceOwner(libraries: readonly Library[], file: string): Library | undefined {
	const fileKey=key(file);
	let owner:Library|undefined;
	for (const library of libraries) {
		if ((!owner || library.location.length>owner.location.length) && sameOrBelow(fileKey,key(library.location))) owner=library;
	}
	return owner;
}

export async function assertWritableOwner(disk: VaultDisk, owner?: Library) {
	if (!owner) return;
	if (!owner.identity || owner.identity.archived || owner.problem || owner.duplicate || owner.git==='special')
		throw new Error(tr('所属知识库无法安全写入','The owning library cannot be updated safely'));
	if (owner.git==='local') await guardGit(await disk.path(owner.location));
}

const decoder = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
export async function readMoveReference(disk: VaultDisk, file: string) {
	await disk.path(file);
	return decoder.decode(await readRelative(disk.root,file));
}

function invalidEdit(file: string) {
	return new Error(tr('引用移动记录无效或引用已变化：','Invalid or changed move reference: ')+file);
}

export function movedMarkdownToken(token: MoveToken, file:string, scope:Scope) {
	return relocateMarkdownReference(token.property?.link ?? token.original,file,token.target,scope.source,scope.destination,token.definition);
}

interface Patch { offset:number; original:string; replacement:string }

export function markdownReferencePatch(text: string, file:string, scope:Scope, token:MoveToken,
	properties?: ReturnType<typeof moveProperties>): Patch {
	const replacement=movedMarkdownToken(token,file,scope);
	if (!replacement || replacement===(token.property?.link ?? token.original)) throw invalidEdit(file);
	if (!token.property) return {...token,replacement};
	const {key,link}=token.property;
	properties??=moveProperties(text);
	const property=properties?.get(key);
	if (!property || !movePropertyTokens(properties,key,link,token.target)
		.some(candidate=>candidate.offset===token.offset && candidate.original===token.original)) throw invalidEdit(file);
	return {...token,replacement:property.encode(replacement)};
}

function referencePatches(text: string, file: string, scope: Scope, references: Exclude<ReferenceEdit['references'],{kind:'canvas'}>) {
	if (references.kind==='canvas-fields') {
		const fields=new Map(canvasFileFields(text).flatMap(field=>field.token ? [[field.token.offset,field.token] as const] : []));
		return references.tokens.map(token=>{
			const field=fields.get(token.offset), next=moveVaultPath(token.target,scope.source,scope.destination);
			if (!field || field.original!==token.original || field.target!==token.target || next===token.target) throw invalidEdit(file);
			return {...token,replacement:JSON.stringify(next)};
		});
	}
	const base=baseMoveTokens(references);
	const fields=base.length ? new Map(moveBaseFields(text,file,scope,false).fields.map(field=>[field.token.offset,field])) : undefined;
	const patches=base.map(token=>{
		const field=fields?.get(token.offset);
		if (!field || field.token.original!==token.original) throw invalidEdit(file);
		return {...token,replacement:field.replacement};
	});
	if (references.kind==='markdown') {
		const properties=references.tokens.some(token=>token.property) ? moveProperties(text) : undefined;
		for (const token of references.tokens) patches.push(markdownReferencePatch(text,file,scope,token,properties));
	}
	return patches;
}

function applyPatches(text:string,file:string,patches:Patch[]) {
	let next=text, end=text.length;
	for (const patch of patches.sort((a,b)=>b.offset-a.offset)) {
		const stop=patch.offset+patch.original.length;
		if (stop>end || text.slice(patch.offset,stop)!==patch.original)
			throw invalidEdit(file);
		next=next.slice(0,patch.offset)+patch.replacement+next.slice(stop);
		end=patch.offset;
	}
	return next;
}

function managedPatches(text:string,file:string,managed:Repair) {
	if (!managed.patches?.length || managed.before!==digest(text)) throw invalidEdit(file);
	const patches=managed.patches.map(({start,end,replacement})=>{
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<=start || end>text.length ||
			typeof replacement!=='string') throw invalidEdit(file);
		return {offset:start,original:text.slice(start,end),replacement};
	});
	if (applyPatches(text,file,[...patches])!==managed.after) throw invalidEdit(file);
	return patches;
}

export function managedReferenceDisposition(patch:Patch, managed?: Repair) {
	if (!managed) return 'ordinary';
	if (!managed.patches?.length) return 'review';
	const end=patch.offset+patch.original.length;
	const overlaps=managed.patches.filter(item=>item.start<end && item.end>patch.offset);
	if (!overlaps.length) return 'ordinary';
	if (overlaps.some(item=>item.start<patch.offset || item.end>end)) return 'review';
	let text=patch.original;
	for (const item of overlaps.sort((a,b)=>b.start-a.start))
		text=text.slice(0,item.start-patch.offset)+item.replacement+text.slice(item.end-patch.offset);
	return text===patch.replacement ? 'covered' : 'review';
}

function transform(text: string, file: string, scope: Scope, references: ReferenceEdit['references'], managed?:Repair) {
	if (references.kind==='canvas') {
		if (managed) throw invalidEdit(file);
		return {after:relocateCanvasReferences(text,scope.source,scope.destination,references.targets)};
	}
	const ordinary=referencePatches(text,file,scope,references);
	const protectedPatches=managed ? managedPatches(text,file,managed) : [];
	const after=applyPatches(text,file,[...protectedPatches,...ordinary]);
	if (references.kind==='markdown' && references.tokens.some(token=>token.property)) {
		const expected=moveProperties(managed?.after ?? text);
		const update=moveProperties(after);
		for (const token of references.tokens) {
			if (!token.property) continue;
			const {key,link}=token.property;
			if (!expected?.get(key)?.value.includes(link) || !update?.get(key)?.value.includes(movedMarkdownToken(token,file,scope)!))
				throw invalidEdit(file);
		}
	}
	const bindingOffsets=managed?.bindingOffsets?.map((slot,index)=>{
		const anchor=protectedPatches[index];
		if (!anchor) throw invalidEdit(file);
		return slot+ordinary.filter(patch=>patch.offset<anchor.offset)
			.reduce((delta,patch)=>delta+patch.replacement.length-patch.original.length,0);
	});
	return {after,bindingOffsets};
}

export function referenceEdit(file: string, owner: Library|undefined, text: string, scope: Scope, references: ReferenceEdit['references'], managed?:Repair): ReferenceEdit {
	const {after,bindingOffsets}=transform(text,file,scope,references,managed);
	if (after===text) throw invalidEdit(file);
	return { file,owner:owner?.identity ? {id:owner.identity.id,location:owner.location} : null,
		before:digest(text),result:digest(after),references,...(bindingOffsets ? {bindingOffsets} : {}) };
}

interface MoveContext extends Scope {
	id: string;
	references?: readonly ReferenceEdit[];
	changes: readonly Repair[];
}

function assertEdit(edit: ReferenceEdit, disk: VaultDisk, config: Config, record: MoveContext) {
	const pathInScope=(file:string)=> {
		disk.validate(file);
		if (config.templates.some(template=>overlaps(file,template))) throw invalidEdit(file);
	};
	pathInScope(edit.file);
	const moving=edit.file.startsWith(record.source+'/');
	if (!moving && overlaps(edit.file,record.destination)) throw invalidEdit(edit.file);
	if (![edit.before,edit.result].every(value=>typeof value==='string' && /^[a-f0-9]{64}$/u.test(value)) ||
		edit.before===edit.result || !edit.references) throw invalidEdit(edit.file);
	const validToken=(token: MoveBaseToken)=>token && typeof token.original==='string' && !!token.original &&
		Number.isSafeInteger(token.offset) && token.offset>=0;
	const validBase=(tokens: MoveBaseToken[])=>Array.isArray(tokens) && tokens.length && tokens.every(validToken);
	if (edit.references.kind==='markdown' && edit.file.toLowerCase().endsWith('.md') &&
		Array.isArray(edit.references.tokens) && (edit.references.tokens.length || edit.references.base!==undefined) &&
		(edit.references.base===undefined || validBase(edit.references.base))) {
		for (const token of edit.references.tokens) {
			if (!validToken(token) || typeof token.target!=='string' || !affectedByMove(edit.file,token.target,record) ||
				(token.definition!==undefined && token.definition!==true) || (token.property!==undefined &&
					(token.definition || !token.property || typeof token.property.key!=='string' || typeof token.property.link!=='string')))
				throw invalidEdit(edit.file);
			disk.validate(token.target);
		}
	} else if (edit.references.kind==='base' && edit.file.toLowerCase().endsWith('.base')) {
		if (!validBase(edit.references.base)) throw invalidEdit(edit.file);
	} else if (edit.references.kind==='canvas' && edit.file.toLowerCase().endsWith('.canvas') &&
		Array.isArray(edit.references.targets) && edit.references.targets.length) {
		for (const path of edit.references.targets) {
			if (typeof path!=='string' || !sameOrBelow(path,record.source)) throw invalidEdit(edit.file);
			disk.validate(path);
		}
	} else if (edit.references.kind==='canvas-fields' && edit.file.toLowerCase().endsWith('.canvas') &&
		Array.isArray(edit.references.tokens) && edit.references.tokens.length) {
		for (const token of edit.references.tokens) {
			if (!validToken(token) || typeof token.target!=='string' || !sameOrBelow(token.target,record.source)) throw invalidEdit(edit.file);
			disk.validate(token.target);
		}
	} else throw invalidEdit(edit.file);
	return moving;
}

// Re-derive text from verified file contents. Recovery persists offsets and known
// targets, never an executable replacement or a second copy of every document.
export async function prepareReferenceWrites(disk: VaultDisk, config: Config, record: MoveContext,
	libraries: readonly Library[], currentSource: string, movingLibrary: Pick<Library,'location'|'identity'>, moved: boolean) {
	if (record.references===undefined) return [];
	if (!Array.isArray(record.references)) throw invalidEdit(record.source);
	const writes: { file: string; before: string; after: string }[] = [];
	const seen=new Set<string>(), authorized=new Set<string>();
	const edits: readonly ReferenceEdit[]=record.references;
	for (const edit of edits) {
		if (!edit || typeof edit.file!=='string' || seen.has(key(edit.file))) throw invalidEdit(record.source);
		seen.add(key(edit.file));
		const inside=assertEdit(edit,disk,config,record);
		const owner=inside ? undefined : referenceOwner(libraries,edit.file);
		const expectedLocation=inside ? record.source : owner?.location;
		const expectedId=inside ? record.id : owner?.identity?.id;
		if (expectedLocation ? !edit.owner || edit.owner.location!==expectedLocation || edit.owner.id!==expectedId : edit.owner!==null)
			throw invalidEdit(edit.file);
		if (owner && !authorized.has(owner.location)) {
			await assertWritableOwner(disk,owner);
			authorized.add(owner.location);
		}
		const text=inside ? decoder.decode(await readRelative(currentSource,edit.file.slice(record.source.length+1))) :
			await readMoveReference(disk,edit.file);
		const signature=digest(text);
		if (moved && signature===edit.result) continue;
		if (signature!==edit.before) throw invalidEdit(edit.file);
		const bindingOwner=inside ? movingLibrary : owner;
		const binding=bindingOwner?.identity?.managed.find(item=>bindingOwner.location+'/'+item.path===edit.file);
		const managed=inside ? record.changes.find(item=>record.source+'/'+item.file===edit.file) : undefined;
		if (binding && bindingOwner && !managed) {
			const classification=await classifyLibraryBinding(disk,inside && moved ? {...bindingOwner,location:record.destination} : bindingOwner,binding,text);
			if (!classification || classification.opaque) throw invalidEdit(edit.file);
		}
		const targets=referenceTargets(edit.references);
		for (const target of new Set<string>(targets)) {
			const stat=sameOrBelow(target,record.source) ? await fs.lstat(await resolvedSourceItem(currentSource,target,record.source)) :
				await fs.lstat(await disk.path(target));
			if (!stat.isFile()) throw invalidEdit(edit.file);
		}
		if (baseMoveTokens(edit.references).length) {
			const offsets=new Set(baseMoveTokens(edit.references).map(token=>token.offset));
			for (const field of moveBaseFields(text,edit.file,record,false).fields) {
				if (!field.link || !offsets.has(field.token.offset)) continue;
				let matchingFiles=0;
				for (const target of [field.link.path,field.link.path+'.md']) {
					const file=await resolvedSourceItem(currentSource,target,record.source);
					if ((await statIfPresent(file))?.isFile()) matchingFiles++;
				}
				if (matchingFiles!==1) throw invalidEdit(edit.file);
			}
		}
		const {after,bindingOffsets}=transform(text,edit.file,record,edit.references,managed);
		if (digest(after)!==edit.result || JSON.stringify(bindingOffsets)!==JSON.stringify(edit.bindingOffsets)) throw invalidEdit(edit.file);
		writes.push({ file:moveVaultPath(edit.file,record.source,record.destination),before:edit.before,after });
	}
	return writes.sort((a,b)=>compareRegistryPaths(a.file,b.file));
}

async function resolvedSourceItem(currentSource:string, file:string, source:string) {
	const relative=file.slice(source.length+1), parent=path.posix.dirname(relative);
	const directory=parent==='.' ? currentSource : await existingDirectory(currentSource,parent);
	return path.join(directory,path.posix.basename(relative));
}
