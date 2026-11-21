import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { segments, statIfPresent } from './paths.ts';
import { PluginDataRegistry } from '../registry/plugin-data.ts';
import type { PluginDataIO } from '../registry/plugin-data.ts';

export { statIfPresent } from './paths.ts';

export const key = (name: string) => name.normalize('NFC').toLowerCase();
export const overlaps = (a: string, b: string) =>
	(key(a) + '/').startsWith(key(b) + '/') || (key(b) + '/').startsWith(key(a) + '/');
export const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export class VaultDisk {
	readonly root: string;
	readonly configDir: string;
	readonly registry: PluginDataRegistry;

	constructor(root: string, configDir: string, data: PluginDataIO) {
		this.root = root;
		this.configDir = configDir;
		this.registry = new PluginDataRegistry(configDir,data);
	}

	validate(relative: string) {
		segments(relative);
		if (overlaps(relative, this.configDir)) throw new Error(fromEnglish('Vault configuration path: ','此路径属于 Vault 配置：') + relative);
	}

	async path(relative: string): Promise<string> {
		this.validate(relative);
		let current = await fs.realpath(this.root);
		for (const part of relative.split('/')) {
			const parent = await statIfPresent(current);
			if (parent) {
				if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(fromEnglish('Unsafe parent: ','父目录不安全：') + current);
				const alias = (await fs.readdir(current)).find(name => name !== part && key(name) === key(part));
				if (alias) throw new Error(fromEnglish('Conflicting path spelling: ','路径名称冲突：') + alias);
			}
			current = path.join(current, part);
			if ((await statIfPresent(current))?.isSymbolicLink()) throw new Error(fromEnglish('Linked path: ','路径含文件系统链接：') + relative);
		}
		return current;
	}
}

export function validateFolders(disk: VaultDisk, parents: string[], templates: string[]) {
	if (!parents.length) throw new Error(fromEnglish('Choose at least one knowledge base parent','请至少选择一个知识库父目录'));
	const paths = [...parents, ...templates];
	for (const [i, name] of paths.entries()) {
		disk.validate(name);
		if (paths.slice(i + 1).some(other => overlaps(name, other))) throw new Error(fromEnglish('Overlapping folders: ','目录范围重叠：') + name);
	}
}
