import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VaultDisk, digest, statIfPresent, validateFolders } from '../fs/vault.ts';
import { readMapping } from './mapping.ts';
import type { Mapping } from './mapping.ts';

import { identityFile, parseIdentity } from './identity-core.ts';
import type { Identity } from './identity-core.ts';
export * from './identity-core.ts';

export interface Library {
	location: string; identity?: Identity; mapping?: Mapping; problem?: string; duplicate?: boolean;
	git: 'local' | 'missing' | 'special'; signature?: string;
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
		const identity = path.join(dir,identityFile), toml = path.join(dir,'kb.toml');
		const json = await statIfPresent(identity), config = await statIfPresent(toml);
		if (!json && !config) return undefined;
		const git = await statIfPresent(path.join(dir,'.git'));
		lib.git = git ? (git.isDirectory() ? 'local' : 'special') : 'missing';
		const parts: string[] = [];
		if (json) {
			if (!json.isFile()) throw new Error(fromEnglish('Expected a regular identity file','知识库身份文件必须为常规文件'));
			const bytes = await fs.readFile(identity);
			lib.identity = parseIdentity(bytes.toString('utf8'));
			parts.push(digest(bytes));
		}
		if (config) {
			if (!config.isFile()) throw new Error(fromEnglish('Expected a regular kb.toml','kb.toml 必须为常规文件'));
			const bytes = await fs.readFile(toml);
			lib.mapping = readMapping(bytes.toString('utf8'));
			parts.push(digest(bytes));
			for (const name of Object.values(lib.mapping)) {
				if (name) await disk.path(location + '/' + name);
			}
		}
		lib.signature = parts.join('/');
	} catch (error) { lib.problem = String(error); }
	return lib;
}

export async function discover(disk: VaultDisk, config: Config): Promise<Library[]> {
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
			if(await statIfPresent(path.join(ancestor,identityFile)) || await statIfPresent(path.join(ancestor,'kb.toml'))){nested=true;break;}
		}
		if(nested)continue;
		for (const child of await fs.readdir(dir,{withFileTypes:true})) {
			if (!child.isDirectory() || child.name.startsWith('.')) continue;
			const lib = await inspect(disk, parent + '/' + child.name);
			if (lib) result.push(lib);
		}
	}
	const ids = new Map<string,number>();
	for (const {identity} of result) if (identity) ids.set(identity.id,(ids.get(identity.id) ?? 0)+1);
	for (const lib of result) if (lib.identity) lib.duplicate = (ids.get(lib.identity.id) ?? 0) > 1;
	return result;
}

export async function recheck(disk: VaultDisk, config: Config, expected: Library): Promise<Library> {
	const current = (await discover(disk,config)).find(lib => lib.location === expected.location);
	if (!current || current.problem || current.duplicate || !current.signature || current.signature !== expected.signature) {
		throw new Error(fromEnglish('Library changed or identity is ambiguous. Refresh the manager.','知识库已变化或身份不唯一。请刷新管理器。'));
	}
	return current;
}
