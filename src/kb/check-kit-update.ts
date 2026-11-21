import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, mkdir, open, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {digest, statIfPresent} from '../fs/vault.ts';
import type {VaultDisk} from '../fs/vault.ts';
import {tr} from '../i18n.ts';
import {checkKitFiles, checkKitVersion} from './check-kit.ts';
import {identityFile, readManifest, writeCheckKit} from './identity-core.ts';
import {readManifestFile, replaceLibraryManifest} from './manifest-disk.ts';

const byteLimit = 1024 * 1024;

interface PresentFile {path: string; digest: string; bytes: Buffer; mode: number}
interface MissingFile {path: string; digest?: undefined}
async function readKitFile(disk: VaultDisk, location: string, name: string): Promise<PresentFile | MissingFile> {
	const relative = location + '/' + name;
	const path = await disk.path(relative);
	const initial = await statIfPresent(path);
	if (!initial) return {path};
	if (!initial.isFile() || initial.nlink !== 1 || initial.size > byteLimit)
		throw new Error(tr('需要独立的常规文件（最多 1 MiB）。','Expected a regular file with a single link (up to 1 MiB).'));
	const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await file.stat();
		if (!current.isFile() || current.nlink !== 1 || current.dev !== initial.dev || current.ino !== initial.ino)
			throw changed(name);
		const buffer = Buffer.alloc(initial.size + 1);
		let size = 0;
		while (size < buffer.length) {
			const {bytesRead} = await file.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		const final = await file.stat();
		if (size !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs ||
			final.ctimeMs !== initial.ctimeMs || final.nlink !== 1 || await disk.path(relative) !== path)
			throw changed(name);
		const entry = await statIfPresent(path);
		if (entry?.dev !== current.dev || entry.ino !== current.ino || entry.nlink !== 1 ||
			entry.mtimeMs !== final.mtimeMs || entry.ctimeMs !== final.ctimeMs) throw changed(name);
		const bytes = buffer.subarray(0, size);
		return {path,digest:digest(bytes),bytes,mode:current.mode};
	} finally { await file.close(); }
}

type Change = 'current' | 'add' | 'replace' | 'modified' | 'missing' | 'unavailable';
interface KitFile {
	path: string;
	change: Change;
	before?: string;
	after: string;
	installedDigest?: string;
	targetDigest: string;
	reason?: string;
}

export interface CheckKitUpdate {
	location: string;
	manifestDigest: string;
	installedVersion: string;
	targetVersion: string;
	canApply: boolean;
	downgrade: boolean;
	files: KitFile[];
}

function changed(name: string) {
	return new Error(tr('检验工具文件已变化，请重新预览。','A check tool file changed. Preview again.') + ' · ' + name);
}

function versionIsNewer(installed: string, bundled: string) {
	if (![installed,bundled].every(version => /^\d+\.\d+\.\d+$/u.test(version))) return false;
	const target = bundled.split('.').map(BigInt);
	for (const [index, value] of installed.split('.').map(BigInt).entries()) {
		const expected = target[index]!;
		if (value !== expected) return value > expected;
	}
	return false;
}

export async function previewCheckKitUpdate(disk: VaultDisk, location: string): Promise<CheckKitUpdate | undefined> {
	const filename = await disk.path(location + '/' + identityFile);
	if (!await statIfPresent(filename)) return;
	const manifest = await readManifestFile(filename);
	const kit = readManifest(manifest.raw).checkKit;
	if (!kit) return;
	const files = await Promise.all(Object.entries(checkKitFiles()).map(async ([path, after]): Promise<KitFile> => {
		const targetDigest = digest(after);
		try {
			const file = await readKitFile(disk, location, path);
			const installedDigest = file.digest;
			const recorded = kit.digests[path];
			const change = installedDigest === targetDigest ? 'current' : file.digest === undefined ? (recorded ? 'missing' : 'add') :
				installedDigest === recorded ? 'replace' : 'modified';
			let before: string | undefined;
			if (file.digest !== undefined && change !== 'current' && !file.bytes.includes(0)) {
				try { before = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(file.bytes); }
				catch { /* Keep binary copies available for manual merge. */ }
			}
			return {path,change,before,after,installedDigest,targetDigest};
		} catch (error) {
			return {path,change:'unavailable',after,targetDigest,reason:String(error)};
		}
	}));
	const downgrade = versionIsNewer(kit.version,checkKitVersion);
	const canApply = !downgrade && (files.some(file => file.change === 'add' || file.change === 'replace') ||
		files.some(file => file.change === 'current' && (kit.version !== checkKitVersion || kit.digests[file.path] !== file.targetDigest)));
	return {location,manifestDigest:manifest.signature,installedVersion:kit.version,targetVersion:checkKitVersion,canApply,downgrade,files};
}

async function publishKitFile(disk: VaultDisk, location: string, file: KitFile) {
	const relative = location + '/' + file.path;
	const output = await disk.path(relative);
	if (file.change === 'add') {
		const parent = relative.slice(0, relative.lastIndexOf('/'));
		await mkdir(await disk.path(parent), {recursive:true});
	}
	const initial = await readKitFile(disk, location, file.path);
	if (initial.path !== output || initial.digest !== file.installedDigest) throw changed(file.path);
	const temporary = join(dirname(output),'.kb-check-' + randomUUID() + '.tmp');
	const handle = await open(temporary, 'wx', 'mode' in initial ? initial.mode & 0o777 : 0o666);
	try {
		try { await handle.writeFile(file.after,'utf8'); await handle.sync(); }
		finally { await handle.close(); }
		const current = await readKitFile(disk, location, file.path);
		if (current.path !== output || current.digest !== initial.digest) throw changed(file.path);
		if (file.change === 'add') await copyFile(temporary, output, constants.COPYFILE_EXCL);
		else await rename(temporary, output);
	} finally { await rm(temporary, {force:true}); }
}

export async function applyCheckKitUpdate(disk: VaultDisk, location: string, approved: CheckKitUpdate) {
	if (approved.location !== location || !approved.canApply) throw changed(location);
	const plan = await previewCheckKitUpdate(disk, location);
	if (!plan || plan.downgrade || plan.manifestDigest !== approved.manifestDigest || plan.targetVersion !== approved.targetVersion ||
		plan.files.length !== approved.files.length || plan.files.some((file,index) => {
			const seen = approved.files[index];
			if (!seen || file.path !== seen.path || file.targetDigest !== seen.targetDigest) return true;
			if (file.change === 'current' && (seen.change === 'replace' || seen.change === 'add')) return false;
			return file.change !== seen.change || file.installedDigest !== seen.installedDigest;
		})) throw changed(location);
	const manifest = await readManifestFile(await disk.path(location + '/' + identityFile));
	const kit = readManifest(manifest.raw).checkKit;
	if (!kit || plan.manifestDigest !== manifest.signature) throw changed(location);
	const digests = {...kit.digests};
	const managed = plan.files.filter(file => file.change === 'current' || file.change === 'replace' || file.change === 'add');
	for (const file of managed) digests[file.path] = file.targetDigest;
	const next = writeCheckKit(manifest.raw, {...kit,version:plan.targetVersion,digests});
	for (const file of managed) {
		if (file.change === 'replace' || file.change === 'add') await publishKitFile(disk, location, file);
	}
	for (const file of managed) {
		if ((await readKitFile(disk, location, file.path)).digest !== file.targetDigest) throw changed(file.path);
	}
	await replaceLibraryManifest(disk, location, plan.manifestDigest, next);
}
