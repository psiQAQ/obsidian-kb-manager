import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { identityFile, inspect } from '../kb/catalog.ts';
import type { Config, Library } from '../kb/catalog.ts';
import { tr } from '../i18n.ts';
import { updateVaultRegistry } from './desktop.ts';
import { amendRegistry, compareRegistryPaths, registryKey, sameOrBelow, validateLibraryPath, validateRegistryPath } from './paths.ts';

export async function assertNoAncestorLibrary(disk:VaultDisk, location:string) {
	const parts = location.split('/');
	let parent = await fs.realpath(disk.root);
	for (const part of parts.slice(0,-1)) {
		if (await statIfPresent(path.join(parent,identityFile))) throw new Error(tr('位置位于另一个知识库内','The folder is inside another library') + ' · ' + location);
		parent = path.join(parent,part);
	}
	if (await statIfPresent(path.join(parent,identityFile))) throw new Error(tr('位置位于另一个知识库内','The folder is inside another library') + ' · ' + location);
}

export async function validateLibraryLocation(disk:VaultDisk, config:Config, location:string) {
	validateLibraryPath(location,disk.configDir,config.templates);
	const folder = await disk.path(location);
	const stat = await statIfPresent(folder);
	if (stat && !stat.isDirectory()) throw new Error(tr('知识库位置必须是目录','The library path must be a folder') + ' · ' + location);
	await assertNoAncestorLibrary(disk,location);
	return folder;
}

export async function registryCandidate(disk:VaultDisk, config:Config, location:string):Promise<Library|undefined> {
	try {
		await validateLibraryLocation(disk,config,location);
		const lib = await inspect(disk,location);
		if (lib && !lib.problem && !lib.identity && !lib.mapping) {
			lib.problem = tr('kb.toml 缺少知识库身份或路径映射','kb.toml is missing a library identity or path mapping');
		}
		return lib;
	} catch (error) { return {location,git:'missing',problem:String(error)}; }
}

export async function registerVaultLibrary(disk:VaultDisk, config:Config, location:string, previous?:string) {
	const lib = await registryCandidate(disk,config,location);
	if (!lib || lib.problem || (!lib.identity && !lib.mapping)) throw new Error(lib?.problem ?? tr('找不到可登记的知识库','No library manifest found for registration') + ' · ' + location);
	await updateVaultRegistry(disk,paths=>amendRegistry(paths,{add:[location],remove:previous === undefined ? [] : [previous]},disk.configDir));
}

export interface FolderScan {libraries:Library[];skipped:string[]}

export async function scanVaultFolder(disk:VaultDisk, config:Config, location:string):Promise<FolderScan> {
	const libraries:Library[] = [];
	const skipped:string[] = [];
	const excluded = [...config.templates,disk.configDir].filter(Boolean).map(registryKey);
	const disallowed = (relative:string)=>excluded.some(root=>sameOrBelow(registryKey(relative),root));
	if (location && disallowed(location)) throw new Error(tr('不能扫描模板或 Vault 配置目录','Template and Vault configuration folders cannot be scanned') + ' · ' + location);
	const selected = await disk.folder(location);
	if (location) await assertNoAncestorLibrary(disk,location);
	async function visit(folder:string, relative:string):Promise<void> {
		if (await statIfPresent(path.join(folder,identityFile))) {
			if (!relative) throw new Error(tr('Vault 根目录的 kb.toml 不能登记为子库','A kb.toml at the Vault root cannot register as a child library'));
			const lib = await registryCandidate(disk,config,relative);
			if (lib) libraries.push(lib);
			return;
		}
		const entries = await fs.readdir(folder,{withFileTypes:true});
		const counts = new Map<string,number>();
		for (const entry of entries) {
			const name = registryKey(entry.name);
			counts.set(name,(counts.get(name) ?? 0)+1);
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.') || registryKey(entry.name) === 'node_modules') continue;
			const current = relative ? relative + '/' + entry.name : entry.name;
			if (disallowed(current)) continue;
			try {
				if (entry.isSymbolicLink()) throw new Error(tr('跳过文件系统链接','Skipped filesystem link'));
				if (!entry.isDirectory()) continue;
				if ((counts.get(registryKey(entry.name)) ?? 0)>1) throw new Error(tr('路径名称冲突','Path spelling conflict'));
				validateRegistryPath(current,disk.configDir);
				await visit(path.join(folder,entry.name),current);
			} catch (error) { skipped.push(current + ' · ' + String(error)); }
		}
	}
	await visit(selected,location);
	libraries.sort((a,b)=>compareRegistryPaths(a.location,b.location));
	return {libraries,skipped:skipped.sort(compareRegistryPaths)};
}
