import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { segments } from './paths.ts';

export const key = (name: string) => name.normalize('NFC').toLowerCase();
export const overlaps = (a: string, b: string) =>
	(key(a) + '/').startsWith(key(b) + '/') || (key(b) + '/').startsWith(key(a) + '/');
export const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export async function statIfPresent(file: string) {
	try { return await fs.lstat(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export class VaultDisk {
	readonly root: string;
	readonly configDir: string;

	constructor(root: string, configDir: string) {
		this.root = root;
		this.configDir = configDir;
	}

	validate(relative: string) {
		segments(relative);
		if (overlaps(relative, this.configDir)) throw new Error('Vault configuration path: ' + relative);
	}

	async path(relative: string): Promise<string> {
		this.validate(relative);
		let current = await fs.realpath(this.root);
		for (const part of relative.split('/')) {
			const parent = await statIfPresent(current);
			if (parent) {
				if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe parent: ' + current);
				const alias = (await fs.readdir(current)).find(name => name !== part && key(name) === key(part));
				if (alias) throw new Error('Conflicting path spelling: ' + alias);
			}
			current = path.join(current, part);
			if ((await statIfPresent(current))?.isSymbolicLink()) throw new Error('Linked path: ' + relative);
		}
		return current;
	}
}

export function validateFolders(disk: VaultDisk, parents: string[], templates: string[]) {
	if (!parents.length) throw new Error('Choose at least one knowledge base parent');
	const paths = [...parents, ...templates];
	for (const [i, name] of paths.entries()) {
		disk.validate(name);
		if (paths.slice(i + 1).some(other => overlaps(name, other))) throw new Error('Overlapping folders: ' + name);
	}
}
