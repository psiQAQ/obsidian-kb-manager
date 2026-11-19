import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VaultDisk, statIfPresent, validateFolders } from '../fs/vault.ts';
import type { Mapping } from './mapping.ts';
import type { GitPreferences } from '../preferences.ts';
import { readVaultRegistry } from '../registry/desktop.ts';
import { registryCandidate } from '../registry/discovery.ts';

import { identityFile, readManifest } from './identity-core.ts';
import type { Identity } from './identity-core.ts';
import { readManifestFile } from './manifest-disk.ts';
export * from './identity-core.ts';

export interface Library {
	location: string; identity?: Identity; mapping?: Mapping; problem?: string; duplicate?: boolean;
	git: 'local' | 'missing' | 'special'; signature?: string; missing?: boolean; preferences?: Partial<GitPreferences>;
}
export interface Config { parents: string[]; templates: string[] }
export const defaults: Config = { parents:['knowledge-base'], templates:[] };
export function newIdentity(name: string, description: string, template: Identity['template'], entry?: string): Identity {
	return { schemaVersion:1, id:randomUUID(), displayName:name, description, archived:false, template, managed:[], entry };
}

export async function inspect(disk: VaultDisk, location: string): Promise<Library | undefined> {
	const lib: Library = { location, git:'missing' };
	try {
		const dir = await disk.path(location);
		const toml = await disk.path(location+'/'+identityFile);
		if (!await statIfPresent(toml)) return undefined;
		const git = await statIfPresent(path.join(dir,'.git'));
		lib.git = git ? (git.isDirectory() ? 'local' : 'special') : 'missing';
		const {raw,signature}=await readManifestFile(toml);
		const manifest=readManifest(raw);
		for (const name of Object.values(manifest.mapping??{})) {
			if (name) await disk.path(location+'/'+name);
		}
		Object.assign(lib,manifest,{signature});
	} catch (error) { lib.problem = String(error); }
	return lib;
}

export async function scan(disk: VaultDisk, config: Config): Promise<Library[]> {
	validateFolders(disk, config.parents, config.templates);
	const result: Library[] = [];
	for (const parent of config.parents) {
		const dir = await disk.path(parent);
		if (!await statIfPresent(dir)) continue;
		// A newly configured parent may itself be inside an existing instance.
		const parts=parent.split('/');
		let nested=false;
		for(let i=0;i<=parts.length;i++){
			const ancestor=i?await disk.path(parts.slice(0,i).join('/')):disk.root;
			if(await statIfPresent(path.join(ancestor,identityFile))){nested=true;break;}
		}
		if(nested)continue;
		for (const child of await fs.readdir(dir,{withFileTypes:true})) {
			if (!child.isDirectory() || child.name.startsWith('.')) continue;
			const lib = await inspect(disk, parent + '/' + child.name);
			if (lib) result.push(lib);
		}
	}
	return markDuplicates(result);
}

function markDuplicates(result:Library[]) {
	const ids = new Map<string,number>();
	for (const {identity} of result) if (identity) ids.set(identity.id,(ids.get(identity.id) ?? 0)+1);
	for (const lib of result) if (lib.identity) lib.duplicate = (ids.get(lib.identity.id) ?? 0) > 1;
	return result;
}

export async function discover(disk: VaultDisk, config: Config): Promise<Library[]> {
	validateFolders(disk,config.parents,config.templates);
	const {paths}=await readVaultRegistry(disk);
	const result=await Promise.all(paths.map(async(location):Promise<Library>=>
		await registryCandidate(disk,config,location) ?? {location,git:'missing',missing:true}));
	return markDuplicates(result);
}

export async function recheck(disk: VaultDisk, config: Config, expected: Library): Promise<Library> {
	const current = (await discover(disk,config)).find(lib => lib.location === expected.location);
	if (!current || current.problem || current.duplicate || !current.signature || current.signature !== expected.signature) {
		throw new Error(fromEnglish('Library changed or identity is ambiguous. Refresh the manager.','知识库已变化或身份不唯一。请刷新管理器。'));
	}
	return current;
}
