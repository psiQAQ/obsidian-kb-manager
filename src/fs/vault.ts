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
			let names: string[] = [];
			if (parent) {
				if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(fromEnglish('Unsafe parent: ','父目录不安全：') + current);
				names = await fs.readdir(current);
				const alias = names.find(name => name !== part && key(name) === key(part));
				if (alias) throw new Error(fromEnglish('Conflicting path spelling: ','路径名称冲突：') + alias);
			}
			current = path.join(current, part);
			const actual = await statIfPresent(current);
			if (actual?.isSymbolicLink()) throw new Error(fromEnglish('Linked path: ','路径含文件系统链接：') + relative);
			if (actual && !names.includes(part)) throw new Error(fromEnglish('Conflicting path spelling: ','路径名称冲突：') + part);
		}
		return current;
	}

	async folder(relative: string, allowMissing = false): Promise<string> {
		const folder = relative ? await this.path(relative) : await fs.realpath(this.root);
		const stat = await statIfPresent(folder);
		if ((!stat && !allowMissing) || (stat && !stat.isDirectory()))
			throw new Error(fromEnglish('Choose an existing folder: ','请选择已存在的目录：') + (relative || '/'));
		return folder;
	}
}
