import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tr } from '../i18n.ts';
import { readRelative } from '../diagnostics/snapshot.ts';
import { existingDirectory } from '../fs/paths.ts';
import { digest, key, overlaps } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { guardGit } from '../git/guard.ts';
import { compareRegistryPaths, sameOrBelow } from '../registry/paths.ts';
import type { Config, Library } from './catalog.ts';
import { moveVaultPath, relocateCanvasReferences, relocateMarkdownReference } from './move-link-text.ts';

interface Scope { source: string; destination: string }
interface Owner { id: string; location: string }
export interface MoveToken { offset: number; original: string; target: string }
export interface ReferenceEdit {
	file: string;
	owner: Owner | null;
	before: string;
	result: string;
	references: { kind: 'markdown'; tokens: MoveToken[] } | { kind: 'canvas'; targets: string[] };
}

export function affectedByMove(file: string, target: string, scope: Scope): boolean {
	return sameOrBelow(file,scope.source) || sameOrBelow(target,scope.source);
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

function transform(text: string, file: string, scope: Scope, references: ReferenceEdit['references']) {
	if (references.kind==='canvas') return relocateCanvasReferences(text,scope.source,scope.destination,references.targets);
	let next=text, end=text.length;
	for (const token of references.tokens) {
		if (token.offset+token.original.length>end || text.slice(token.offset,token.offset+token.original.length)!==token.original)
			throw invalidEdit(file);
		const replacement=relocateMarkdownReference(token.original,file,token.target,scope.source,scope.destination);
		if (!replacement || replacement===token.original) throw invalidEdit(file);
		next=next.slice(0,token.offset)+replacement+next.slice(token.offset+token.original.length);
		end=token.offset;
	}
	return next;
}

export function referenceEdit(file: string, owner: Library|undefined, text: string, scope: Scope, references: ReferenceEdit['references']): ReferenceEdit {
	const after=transform(text,file,scope,references);
	if (after===text) throw invalidEdit(file);
	return { file,owner:owner?.identity ? {id:owner.identity.id,location:owner.location} : null,
		before:digest(text),result:digest(after),references };
}

interface MoveContext extends Scope {
	id: string;
	references?: readonly ReferenceEdit[];
	changes: readonly { file: string }[];
}

function assertEdit(edit: ReferenceEdit, disk: VaultDisk, config: Config, record: MoveContext) {
	const pathInScope=(file:string)=> {
		disk.validate(file);
		if (config.templates.some(template=>overlaps(file,template))) throw invalidEdit(file);
	};
	pathInScope(edit.file);
	const moving=edit.file.startsWith(record.source+'/');
	if (!moving && overlaps(edit.file,record.destination)) throw invalidEdit(edit.file);
	if (moving && record.changes.some(change=>record.source+'/'+change.file===edit.file)) throw invalidEdit(edit.file);
	if (![edit.before,edit.result].every(value=>typeof value==='string' && /^[a-f0-9]{64}$/u.test(value)) ||
		edit.before===edit.result || !edit.references) throw invalidEdit(edit.file);
	if (edit.references.kind==='markdown' && edit.file.toLowerCase().endsWith('.md') &&
		Array.isArray(edit.references.tokens) && edit.references.tokens.length) {
		for (const token of edit.references.tokens) {
			if (!token || typeof token.target!=='string' || typeof token.original!=='string' || !token.original ||
				!Number.isSafeInteger(token.offset) || token.offset<0 || !affectedByMove(edit.file,token.target,record)) throw invalidEdit(edit.file);
			disk.validate(token.target);
		}
	} else if (edit.references.kind==='canvas' && edit.file.toLowerCase().endsWith('.canvas') &&
		Array.isArray(edit.references.targets) && edit.references.targets.length) {
		for (const path of edit.references.targets) {
			if (typeof path!=='string' || !sameOrBelow(path,record.source)) throw invalidEdit(edit.file);
			disk.validate(path);
		}
	} else throw invalidEdit(edit.file);
	return moving;
}

// Re-derive text from verified file contents. Recovery persists offsets and known
// targets, never an executable replacement or a second copy of every document.
export async function prepareReferenceWrites(disk: VaultDisk, config: Config, record: MoveContext,
	libraries: readonly Library[], currentSource: string, moved: boolean) {
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
		const targets=edit.references.kind==='canvas' ? edit.references.targets : edit.references.tokens.map(token=>token.target);
		for (const target of new Set<string>(targets)) {
			const stat=sameOrBelow(target,record.source) ? await fs.lstat(await resolvedSourceItem(currentSource,target,record.source)) :
				await fs.lstat(await disk.path(target));
			if (!stat.isFile()) throw invalidEdit(edit.file);
		}
		const after=transform(text,edit.file,record,edit.references);
		if (digest(after)!==edit.result) throw invalidEdit(edit.file);
		writes.push({ file:moveVaultPath(edit.file,record.source,record.destination),before:edit.before,after });
	}
	return writes.sort((a,b)=>compareRegistryPaths(a.file,b.file));
}

async function resolvedSourceItem(currentSource:string, file:string, source:string) {
	const relative=file.slice(source.length+1), parent=path.posix.dirname(relative);
	const directory=parent==='.' ? currentSource : await existingDirectory(currentSource,parent);
	return path.join(directory,path.posix.basename(relative));
}
