import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, mkdir, open, rename, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {digest, statIfPresent} from '../fs/vault.ts';
import type {VaultDisk} from '../fs/vault.ts';
import {tr} from '../i18n.ts';
import {checkKitFiles, checkKitVersion} from './check-kit.ts';
import {courseworkDeclaration, courseworkLinkDeclaration, courseworkScript, courseworkTemplate, previousCourseworkDigests} from './coursework-check.ts';
import {identityFile, readManifest, writeCheckKit} from './identity-core.ts';
import {readManifestFile, replaceLibraryManifest} from './manifest-disk.ts';
import {officialCheckDigests, packText} from './template-pack.ts';

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

type Change = 'current' | 'add' | 'replace' | 'modified' | 'missing' | 'unavailable' | 'blocked';
interface KitFile {
	path: string;
	change: Change;
	before?: string;
	after?: string;
	installedDigest?: string;
	targetDigest?: string;
	reason?: string;
}
type EligibleFile = KitFile & {change: 'current' | 'add' | 'replace'; after: string; targetDigest: string};

function eligible(file: KitFile): file is EligibleFile {
	return (file.change === 'current' || file.change === 'add' || file.change === 'replace') && file.after !== undefined && !!file.targetDigest;
}

export interface CheckKitUpdate {
	location: string;
	manifestDigest: string;
	installedVersion: string;
	targetVersion: string;
	canApply: boolean;
	downgrade: boolean;
	files: KitFile[];
	courseworkFiles: KitFile[];
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

async function inspectKitFile(disk: VaultDisk, location: string, path: string): Promise<KitFile> {
	try {
		const file = await readKitFile(disk, location, path);
		if (file.digest === undefined) return {path,change:'missing'};
		let before: string | undefined;
		if (!file.bytes.includes(0)) {
			try { before = new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(file.bytes); }
			catch { /* Keep binary copies available for manual merge. */ }
		}
		return {path,change:'modified',before,installedDigest:file.digest};
	} catch (error) {
		return {path,change:'unavailable',reason:String(error)};
	}
}

function candidate(file: KitFile, after: string, change: Change): KitFile {
	const targetDigest = digest(after);
	if (file.installedDigest === targetDigest) return {...file,change:'current',before:undefined,after,targetDigest};
	return {...file,change,after,targetDigest};
}

async function previewCourseworkFiles(disk: VaultDisk, location: string, version: string): Promise<KitFile[]> {
	const source = packText(courseworkTemplate)[courseworkScript];
	if (!source || !officialCheckDigests().includes(digest(source))) return [];
	const [script, descriptor] = await Promise.all([
		inspectKitFile(disk,location,courseworkScript),inspectKitFile(disk,location,courseworkDeclaration),
	]);
	const nextScript = candidate(script,source,script.installedDigest && previousCourseworkDigests.includes(script.installedDigest) ? 'replace' : script.change);
	let after: string | undefined;
	if (descriptor.before !== undefined) {
		try { after = courseworkLinkDeclaration(descriptor.before,version); }
		catch { /* The library's declaration needs manual review. */ }
	}
	const nextDescriptor = after === undefined ? descriptor : candidate(descriptor,after,'replace');
	const files = [nextScript,nextDescriptor];
	if (files.every(eligible)) return files;
	return files.map(file => {
		if (file.change !== 'replace') return file;
		const paired = file === nextScript ? courseworkDeclaration : courseworkScript;
		return {...file,change:'blocked',reason:tr('请先检查配套文件','Review the companion file first') + ' · ' + paired};
	});
}

export async function previewCheckKitUpdate(disk: VaultDisk, location: string): Promise<CheckKitUpdate | undefined> {
	const filename = await disk.path(location + '/' + identityFile);
	if (!await statIfPresent(filename)) return;
	const manifest = await readManifestFile(filename);
	const {checkKit:kit, identity} = readManifest(manifest.raw);
	if (!kit) return;
	const [files, courseworkFiles] = await Promise.all([
		Promise.all(Object.entries(checkKitFiles()).map(async ([path, after]) => {
			const file = await inspectKitFile(disk, location, path);
			const recorded = kit.digests[path];
			return candidate(file,after,recorded && file.installedDigest === recorded ? 'replace' :
				file.change === 'missing' && !recorded ? 'add' : file.change);
		})),
		identity?.template.id === courseworkTemplate ? previewCourseworkFiles(disk,location,identity.template.version) : [],
	]);
	const downgrade = versionIsNewer(kit.version,checkKitVersion);
	const canApply = !downgrade && (files.some(file => file.change === 'add' || file.change === 'replace') ||
		files.some(file => file.change === 'current' && (kit.version !== checkKitVersion || kit.digests[file.path] !== file.targetDigest)) ||
		courseworkFiles.some(file => file.change === 'replace'));
	return {location,manifestDigest:manifest.signature,installedVersion:kit.version,targetVersion:checkKitVersion,canApply,downgrade,files,courseworkFiles};
}

async function publishKitFile(disk: VaultDisk, location: string,
	file: Pick<EligibleFile,'path'|'change'|'after'|'installedDigest'>) {
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

async function assertFileDigest(disk: VaultDisk, location: string, file: KitFile, expected: string | undefined) {
	if ((await readKitFile(disk,location,file.path)).digest !== expected) throw changed(file.path);
}

async function applyCourseworkFiles(disk: VaultDisk, location: string, files: KitFile[]) {
	const [script, descriptor] = files;
	if (!script || !descriptor || !eligible(script) || !eligible(descriptor)) return;
	await assertFileDigest(disk,location,script,script.installedDigest);
	await assertFileDigest(disk,location,descriptor,descriptor.installedDigest);
	if (script.change === 'replace') await publishKitFile(disk,location,script);
	try {
		await assertFileDigest(disk,location,script,script.targetDigest);
		if (descriptor.change === 'replace') await publishKitFile(disk,location,descriptor);
	} catch (error) {
		if (script.change === 'replace' && script.before !== undefined) {
			try {
				const installed = descriptor.change === 'replace' ? await readKitFile(disk,location,descriptor.path).catch(() => undefined) : undefined;
				const current = await readKitFile(disk,location,script.path);
				if (installed?.digest !== descriptor.targetDigest && current.digest === script.targetDigest) await publishKitFile(disk,location,{
					path:script.path,change:'replace',installedDigest:script.targetDigest,after:script.before,
				});
			} catch (rollback) {
				throw new AggregateError([error,rollback],tr('课程检查文件更新中断，请重新预览。',
					'The course check update was interrupted. Preview again.'));
			}
		}
		throw error;
	}
	await assertFileDigest(disk,location,script,script.targetDigest);
	await assertFileDigest(disk,location,descriptor,descriptor.targetDigest);
}

function matchesApproval(files: KitFile[], approved: KitFile[]) {
	return files.length === approved.length && files.every((file,index) => {
		const seen = approved[index];
		if (!seen || file.path !== seen.path || file.targetDigest !== seen.targetDigest) return false;
		if (file.change === 'current' && (seen.change === 'replace' || seen.change === 'add')) return true;
		return file.change === seen.change && file.installedDigest === seen.installedDigest;
	});
}

export async function applyCheckKitUpdate(disk: VaultDisk, location: string, approved: CheckKitUpdate) {
	if (approved.location !== location || !approved.canApply) throw changed(location);
	const plan = await previewCheckKitUpdate(disk, location);
	if (!plan || plan.downgrade || plan.manifestDigest !== approved.manifestDigest || plan.targetVersion !== approved.targetVersion ||
		!matchesApproval(plan.files,approved.files) || !matchesApproval(plan.courseworkFiles,approved.courseworkFiles)) throw changed(location);
	const manifest = await readManifestFile(await disk.path(location + '/' + identityFile));
	const kit = readManifest(manifest.raw).checkKit;
	if (!kit || plan.manifestDigest !== manifest.signature) throw changed(location);
	const digests = {...kit.digests};
	const managed = plan.files.filter(eligible);
	for (const file of managed) digests[file.path] = file.targetDigest;
	const next = writeCheckKit(manifest.raw, {...kit,version:plan.targetVersion,digests});
	for (const file of managed) {
		if (file.change === 'replace' || file.change === 'add') await publishKitFile(disk, location, file);
	}
	if (plan.courseworkFiles.some(file => file.change === 'replace')) {
		if ((await readManifestFile(await disk.path(location+'/'+identityFile))).signature !== plan.manifestDigest) throw changed(identityFile);
		await applyCourseworkFiles(disk,location,plan.courseworkFiles);
	}
	for (const file of managed) await assertFileDigest(disk,location,file,file.targetDigest);
	await replaceLibraryManifest(disk, location, plan.manifestDigest, next);
}
