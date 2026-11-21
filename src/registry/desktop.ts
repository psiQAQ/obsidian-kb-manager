import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { statIfPresent } from '../fs/paths.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { withLibraryIgnores } from '../kb/identity-core.ts';
import { legacyDirectoryIsConfig, registryDirectory, registryIgnoreFor, registryKey, registryName, registryPath, withIgnoreRule } from './paths.ts';

export type RegistrySnapshot = Awaited<ReturnType<VaultDisk['registry']['read']>>;
type FileSnapshot = {raw:string;mode:number}|null;

async function exactChild(directory:string, name:string) {
	const target = path.join(directory,name);
	const entries = await fs.readdir(directory);
	if (entries.some(entry => entry !== name && registryKey(entry) === registryKey(name))) {
		throw new Error(tr('路径名称冲突','Path spelling conflict') + ' · ' + name);
	}
	return target;
}

async function registryFolder(disk:VaultDisk) {
	const folder = await exactChild(await fs.realpath(disk.root),registryDirectory);
	const status = await statIfPresent(folder);
	if (status && !status.isDirectory()) throw new Error(tr('登记目录必须是真实目录','The registry folder must be a real directory'));
	return {folder,status};
}

async function readFile(filename:string):Promise<FileSnapshot> {
	const stat = await statIfPresent(filename);
	if (!stat) return null;
	if (!stat.isFile() || stat.nlink !== 1) throw new Error(tr('需要独立的常规文件','Expected a regular file with a single link') + ' · ' + path.basename(filename));
	const file = await fs.open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await file.stat();
		if (!current.isFile() || current.nlink !== 1 || current.dev !== stat.dev || current.ino !== stat.ino) {
			throw new Error(tr('读取时文件已变化','The file changed while opening') + ' · ' + path.basename(filename));
		}
		return {raw:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.readFile()),mode:current.mode & 0o777};
	} finally { await file.close(); }
}

export function desktopLegacyRegistry(disk:VaultDisk) {
	return {
		async read() {
			if (legacyDirectoryIsConfig(disk.configDir)) return null;
			try {
				const {folder,status} = await registryFolder(disk);
				return status ? (await readFile(await exactChild(folder,registryName)))?.raw ?? null : null;
			} catch(error) {
				throw new Error(tr('无法读取旧登记文件，请检查','Could not read the legacy registry. Check') + ' · ' + registryPath + ' · ' + String(error));
			}
		},
		async remove(expected:string) {
			if (legacyDirectoryIsConfig(disk.configDir)) throw new Error(tr('旧登记目录属于 Vault 配置','The legacy registry folder belongs to the Vault configuration'));
			const {folder,status} = await registryFolder(disk);
			const changed = () => new Error(tr('旧版登记已变化，请重新预览','The legacy registry changed. Preview it again'));
			if (!status) throw changed();
			const filename = await exactChild(folder,registryName);
			const original = await statIfPresent(filename);
			if ((await readFile(filename))?.raw !== expected || !original) throw changed();
			const currentFolder = await statIfPresent(folder);
			if (!currentFolder?.isDirectory() || currentFolder.dev !== status.dev || currentFolder.ino !== status.ino) throw changed();
			const current = await statIfPresent(filename);
			if (!current?.isFile() || current.nlink !== 1 || current.dev !== original.dev || current.ino !== original.ino ||
				current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs) throw changed();
			await fs.unlink(filename);
			const remaining = await statIfPresent(folder);
			if (!remaining?.isDirectory() || remaining.dev !== status.dev || remaining.ino !== status.ino) return;
			try { await fs.rmdir(folder); }
			catch (error) {
				if (!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
			}
		},
	};
}

export function readRegistryRaw(disk:VaultDisk) { return disk.registry.readRaw(); }

export function readVaultRegistry(disk:VaultDisk):Promise<RegistrySnapshot> { return disk.registry.read(); }

const updates = new Map<string,Promise<unknown>>();
async function serializeUpdate<T>(target:string, update:()=>Promise<T>) {
	const previous = updates.get(target);
	const pending = (previous?.catch(()=>undefined) ?? Promise.resolve()).then(update);
	updates.set(target,pending);
	try { return await pending; }
	finally { if (updates.get(target) === pending) updates.delete(target); }
}

async function replaceFile(filename:string, before:string|null, after:string, mode:number) {
	const initial = await readFile(filename);
	if ((initial?.raw ?? null) !== before) throw new Error(tr('文件已变化，请重新预览','File changed. Preview the update again') + ' · ' + path.basename(filename));
	if (before === after) return;
	const temporary = path.join(path.dirname(filename),'.kb-manager-write-' + randomUUID() + '.tmp');
	const handle = await fs.open(temporary,'wx',mode);
	try {
		try {
			await handle.writeFile(after);
			await handle.sync();
		} finally { await handle.close(); }
		const current = await readFile(filename);
		if ((current?.raw ?? null) !== before) throw new Error(tr('文件已变化，请重新预览','File changed. Preview the update again') + ' · ' + path.basename(filename));
		if (current) await fs.rename(temporary,filename);
		else await fs.link(temporary,filename);
	} finally {
		await fs.rm(temporary,{force:true});
	}
}

export function writeVaultRegistry(disk:VaultDisk, before:string|null, paths:readonly string[], prepare?:()=>Promise<void>) {
	return disk.registry.write(before,paths,prepare);
}

export function updateVaultRegistry(disk:VaultDisk, change:(paths:readonly string[])=>string[]) {
	return disk.registry.update(change);
}

async function ignoreFilename(disk:VaultDisk, location:string) {
	return exactChild(location ? await disk.path(location) : await fs.realpath(disk.root),'.gitignore');
}

type IgnorePreview = {before:string|null;after:string;location:string};
type IgnoreEdit = (raw:string|null)=>string;

async function previewIgnore(disk:VaultDisk,location:string,edit:IgnoreEdit):Promise<IgnorePreview> {
	const before = (await readFile(await ignoreFilename(disk,location)))?.raw ?? null;
	return {before,after:edit(before),location};
}

async function applyIgnore(disk:VaultDisk,preview:IgnorePreview,edit:IgnoreEdit) {
	const filename = await ignoreFilename(disk,preview.location);
	return serializeUpdate(filename,async()=>{
		const current = await readFile(filename);
		const raw = current?.raw ?? null;
		if (raw === preview.after && edit(raw) === raw) return;
		if (raw !== preview.before || edit(raw) !== preview.after) throw new Error(tr('忽略规则已变化，请重新预览','Ignore rules changed. Preview the update again'));
		await replaceFile(filename,raw,preview.after,current?.mode ?? 0o644);
	});
}

export async function previewIgnoreRule(disk:VaultDisk, location:string, rule:string) {
	return {...await previewIgnore(disk,location,raw=>withIgnoreRule(raw,rule)),rule};
}

export function applyIgnoreRule(disk:VaultDisk, preview:IgnorePreview & {rule:string}) {
	return applyIgnore(disk,preview,raw=>withIgnoreRule(raw,preview.rule));
}

const libraryIgnore:IgnoreEdit=raw=>withLibraryIgnores(raw ?? '');
export function previewLibraryIgnores(disk:VaultDisk,location:string) {
	return previewIgnore(disk,location,libraryIgnore);
}

export function applyLibraryIgnores(disk:VaultDisk,preview:IgnorePreview) {
	return applyIgnore(disk,preview,libraryIgnore);
}

export function previewRegistryIgnore(disk:VaultDisk) {
	return previewIgnoreRule(disk,'',registryIgnoreFor(disk.configDir));
}
