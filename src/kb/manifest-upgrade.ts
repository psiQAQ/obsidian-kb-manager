import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { key, statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { applyLibraryIgnores, previewLibraryIgnores } from '../registry/desktop.ts';
import { identityFile, parseIdentity, recheck, writeIdentity } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { readManifestFile, replaceLibraryManifest } from './manifest-disk.ts';
import { applyUpgradeChecks, previewUpgradeChecks } from './upgrade-checks.ts';

async function logLocation(disk: VaultDisk, location: string) {
	const root = await disk.path(location);
	if ((await readdir(root)).some(name => name !== '.log' && key(name) === '.log'))
		throw new Error(tr('已有同名日志位置。','A conflicting log path already exists.'));
	const path = join(root,'.log');
	const stat = await statIfPresent(path);
	if (stat && !stat.isDirectory()) throw new Error(tr('日志位置须为普通目录。','The log location must be a regular directory.'));
	return {path, exists:!!stat};
}

export async function previewManifestUpgrade(disk: VaultDisk, library: Library) {
	if (library.identity?.schemaVersion !== 1 || library.identity.archived || library.duplicate || library.problem) return;
	const relative = library.location + '/' + identityFile;
	const {raw, signature} = await readManifestFile(await disk.path(relative));
	const current = parseIdentity(raw);
	if (signature !== library.signature || current.schemaVersion !== 1)
		throw new Error(tr('清单已变化，请刷新。','The manifest changed. Refresh the library list.'));
	const updated = writeIdentity(raw,{...current,schemaVersion:2});
	const ignores = await previewLibraryIgnores(disk,library.location);
	const log = await logLocation(disk,library.location);
	const checks = await previewUpgradeChecks(disk,library);
	return {library, relative, signature, updated, ignores, log, checks, id:current.id};
}

type ManifestUpgrade = NonNullable<Awaited<ReturnType<typeof previewManifestUpgrade>>>;

export async function applyManifestUpgrade(disk: VaultDisk, config: Config, preview: ManifestUpgrade) {
	const {library, signature, updated, ignores, log, checks} = preview;
	const current = await recheck(disk,config,library);
	const target = await logLocation(disk,library.location);
	// A failed manifest replacement can leave the previewed log directory and ignore rules in place.
	if (target.path !== log.path || (log.exists && !target.exists))
		throw new Error(tr('日志位置已变化，请重新预览。','The log location changed. Preview again.'));
	const currentIgnores = await previewLibraryIgnores(disk,library.location);
	if (currentIgnores.after !== ignores.after || (currentIgnores.before !== ignores.before && currentIgnores.before !== ignores.after))
		throw new Error(tr('忽略规则已变化，请重新预览','Ignore rules changed. Preview the update again') + ' · .gitignore');
	await applyUpgradeChecks(disk,current,checks);
	await applyLibraryIgnores(disk,currentIgnores);
	if (!target.exists) await mkdir(target.path);
	await replaceLibraryManifest(disk,library.location,signature,updated);
}
