import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { digest, statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import type { Library } from './catalog.ts';
import { isBuiltinWiki, isKepano } from './template-core.ts';
import { declaration } from './template-declaration.ts';
import type { Declaration } from './template-declaration.ts';
import { builtinPacks, officialCheckDigests, packText } from './template-pack.ts';

interface UpgradeFile {
	path: string;
	content: string;
	fingerprint: string;
	existing: boolean;
}

export interface UpgradeChecks {
	location: string;
	files: UpgradeFile[];
	manual: string[];
}

const declarationPath = 'kb-template.json';

function changed(name: string) {
	return new Error(tr('专项文件预览已变化，请重新预览。','A check file changed. Preview again.') + ' · ' + name);
}

async function fileState(disk: VaultDisk, root: string, record: UpgradeFile) {
	const relative = root + '/' + record.path;
	const path = await disk.path(relative);
	const initial = await statIfPresent(path);
	if (!initial) return { path, existing:false };
	if (!initial.isFile() || initial.nlink !== 1 || initial.size !== new TextEncoder().encode(record.content).byteLength) throw changed(relative);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const current = await handle.stat();
		if (!current.isFile() || current.nlink !== 1 || current.dev !== initial.dev || current.ino !== initial.ino ||
			digest(await handle.readFile()) !== record.fingerprint || await disk.path(relative) !== path) throw changed(relative);
		const same = await statIfPresent(path);
		if (same?.dev !== current.dev || same.ino !== current.ino) throw changed(relative);
		return { path, existing:true };
	} finally { await handle.close(); }
}

async function availablePaths(disk: VaultDisk, library: Library, candidates: (string | undefined)[], folder: boolean) {
	const paths: string[] = [];
	for (const relative of new Set(candidates)) {
		if (!relative) continue;
		const stat = await statIfPresent(await disk.path(library.location + '/' + relative));
		if (folder ? stat?.isDirectory() : stat?.isFile()) {
			paths.push(relative);
			if (!folder) break;
		}
	}
	return paths;
}

function upgradeFile(path: string, content: string): UpgradeFile {
	return { path, content, fingerprint:digest(content), existing:false };
}

export async function previewUpgradeChecks(disk: VaultDisk, library: Library): Promise<UpgradeChecks> {
	const empty = {location:library.location, files:[], manual:[]};
	const identity = library.identity;
	const template = identity?.template;
	if (identity?.schemaVersion !== 1 || (!isBuiltinWiki(template) && !isKepano(template))) return empty;
	const pack = builtinPacks().find(item => item.id === template?.id);
	if (!pack?.checks?.length || pack.version === template?.version) return empty;
	const official = new Set(officialCheckDigests());
	const resources = packText(pack.id);
	const files: UpgradeFile[] = [];
	for (const check of pack.checks) {
		const content = resources[check.path];
		if (!content) return empty;
		const file = upgradeFile(check.path, content);
		if (!official.has(file.fingerprint)) return empty;
		files.push(file);
	}
	const manual: string[] = [];
	try {
		const [entry] = await availablePaths(disk, library, [identity.entry, library.mapping?.index, pack.entry], false);
		const candidates = [library.mapping?.templates, ...(pack.pageTemplates ?? [])];
		const pageTemplates = await availablePaths(disk, library, candidates, true);
		const spec: Declaration = { id:pack.id, version:identity.template.version, name:pack.name, description:pack.description,
			purpose:pack.purpose, entry, ...(pageTemplates.length && {pageTemplates}), checks:pack.checks, sources:pack.sources };
		const content = JSON.stringify(spec, null, 2) + '\n';
		declaration(content);
		files.push(upgradeFile(declarationPath, content));
	} catch (error) {
		return {...empty,manual:[tr('请人工核对旧库入口与模板目录。','Review the legacy entry and template folders.') + ' · ' + String(error)]};
	}
	for (const file of files) {
		try { file.existing = (await fileState(disk, library.location, file)).existing; }
		catch {
			manual.push(tr('已有文件或路径不同，请人工核对。','An existing file or path differs. Review it manually.') + ' · ' + file.path);
		}
	}
	return {location:library.location, files:manual.length ? [] : files, manual};
}

export async function applyUpgradeChecks(disk: VaultDisk, library: Library, preview: UpgradeChecks) {
	if (preview.location !== library.location) throw changed(library.location);
	if (!preview.files.length) return;
	const fresh = await previewUpgradeChecks(disk, library);
	if (fresh.files.length !== preview.files.length || fresh.files.some((file, index) => {
		const previous = preview.files[index]!;
		return file.path !== previous.path || file.fingerprint !== previous.fingerprint || (previous.existing && !file.existing);
	})) throw changed(library.location);
	const folder = await disk.path(library.location + '/checks');
	try { await mkdir(folder); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
	if (!(await statIfPresent(await disk.path(library.location + '/checks')))?.isDirectory()) throw changed(folder);
	for (const file of fresh.files) {
		if (file.path === declarationPath) {
			for (const script of fresh.files.filter(item => item.path !== declarationPath)) {
				if (!(await fileState(disk, library.location, script)).existing) throw changed(script.path);
			}
		}
		const state = await fileState(disk, library.location, file);
		if (state.existing) continue;
		let handle;
		try { handle = await open(state.path, 'wx'); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST' && (await fileState(disk, library.location, file)).existing) continue;
			throw error;
		}
		try {
			await handle.writeFile(file.content, 'utf8');
			await handle.sync();
		} finally { await handle.close(); }
		if (!(await fileState(disk, library.location, file)).existing) throw changed(file.path);
	}
}
