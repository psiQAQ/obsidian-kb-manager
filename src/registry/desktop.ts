import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { parseRegistry, registryDirectory, registryIgnoreRule, registryKey, registryName, serializeRegistry, validateRegistryDirectory, withIgnoreRule } from './paths.ts';

export interface RegistrySnapshot {raw:string|null;paths:string[]}
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
	validateRegistryDirectory(disk.configDir);
	const folder = await exactChild(await fs.realpath(disk.root),registryDirectory);
	const status = await statIfPresent(folder);
	if (status && !status.isDirectory()) throw new Error(tr('登记目录必须是真实目录','The registry folder must be a real directory'));
	return {folder,exists:!!status};
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

export async function readRegistryRaw(disk:VaultDisk) {
	const {folder,exists} = await registryFolder(disk);
	return exists ? (await readFile(await exactChild(folder,registryName)))?.raw ?? null : null;
}

export async function readVaultRegistry(disk:VaultDisk):Promise<RegistrySnapshot> {
	const raw = await readRegistryRaw(disk);
	return {raw,paths:raw === null ? [] : parseRegistry(raw,disk.configDir)};
}

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

async function publishRegistry(disk:VaultDisk, before:string|null, paths:readonly string[]) {
	const after = serializeRegistry(paths,disk.configDir);
	const {folder,exists} = await registryFolder(disk);
	if (!exists) {
		if (before !== null) throw new Error(tr('登记文件已变化，请重新预览','Registry changed. Preview the update again'));
		try { await fs.mkdir(folder); }
		catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
		await registryFolder(disk);
	}
	return replaceFile(await exactChild(folder,registryName),before,after,0o600);
}

export async function writeVaultRegistry(disk:VaultDisk, before:string|null, paths:readonly string[], prepare?:()=>Promise<void>) {
	serializeRegistry(paths,disk.configDir);
	return serializeUpdate(path.join(await fs.realpath(disk.root),registryDirectory),async()=>{
		if (await readRegistryRaw(disk) !== before) throw new Error(tr('登记文件已变化，请重新预览','Registry changed. Preview the update again'));
		await prepare?.();
		await publishRegistry(disk,before,paths);
	});
}

export async function updateVaultRegistry(disk:VaultDisk, change:(paths:readonly string[])=>string[]) {
	return serializeUpdate(path.join(await fs.realpath(disk.root),registryDirectory),async()=>{
		const {raw,paths} = await readVaultRegistry(disk);
		const next = change(paths);
		if (JSON.stringify(paths) !== JSON.stringify(next)) await publishRegistry(disk,raw,next);
	});
}

async function ignoreFilename(disk:VaultDisk, location:string) {
	return exactChild(location ? await disk.path(location) : await fs.realpath(disk.root),'.gitignore');
}

export async function previewIgnoreRule(disk:VaultDisk, location:string, rule:string) {
	const before = (await readFile(await ignoreFilename(disk,location)))?.raw ?? null;
	return {before,after:withIgnoreRule(before,rule),location,rule};
}

export async function applyIgnoreRule(disk:VaultDisk, preview:Awaited<ReturnType<typeof previewIgnoreRule>>) {
	const filename = await ignoreFilename(disk,preview.location);
	return serializeUpdate(filename,async()=>{
		const current = await readFile(filename);
		const raw = current?.raw ?? null;
		if (raw !== preview.before || withIgnoreRule(raw,preview.rule) !== preview.after) throw new Error(tr('忽略规则已变化，请重新预览','Ignore rules changed. Preview the update again'));
		await replaceFile(filename,raw,preview.after,current?.mode ?? 0o644);
	});
}

export function previewRegistryIgnore(disk:VaultDisk) {
	return previewIgnoreRule(disk,'',registryIgnoreRule);
}
