import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { digest, statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { discover, identityFile, writeIdentity } from '../kb/catalog.ts';
import type { Config, Library } from '../kb/catalog.ts';
import { examine } from '../kb/maintenance.ts';
import type { Repair, VisibleFiles } from '../kb/maintenance.ts';
import { readManifestFile, replaceLibraryManifest } from '../kb/manifest-disk.ts';
import { readVaultRegistry, writeVaultRegistry } from './desktop.ts';
import type { RegistrySnapshot } from './desktop.ts';
import { registryCandidate } from './discovery.ts';
import { amendRegistry } from './paths.ts';

interface Rebinding extends Repair {before:string;original:string}

export async function prepareRebinding(disk:VaultDisk, lib:Library, skeleton:Record<string,string>) {
	const changes:Rebinding[] = [];
	const manual:string[] = [];
	if (!lib.identity) return {changes,manual};
	const managed = lib.identity.managed.filter(item=>item.root !== lib.location);
	if (!managed.length) return {changes,manual};
	const safe: typeof managed = [];
	for (const item of managed) {
		try {
			if (!item.root) throw new Error(tr('缺少原 Vault 绑定路径','Missing original Vault binding path'));
			if (lib.identity.archived) throw new Error(tr('已归档，恢复活动状态后才能重绑','Archived. Restore to active status before rebinding'));
			const absolute = await disk.path(lib.location + '/' + item.path);
			const stat = await statIfPresent(absolute);
			if (!stat?.isFile() || stat.nlink !== 1 || digest(await fs.readFile(absolute)) !== item.fingerprint) {
				throw new Error(tr('文件指纹不一致，需人工复核','The file fingerprint differs. Review it manually'));
			}
			safe.push(item);
		} catch (error) { manual.push(item.path + ' · ' + String(error)); }
	}
	if (!safe.length) return {changes,manual};
	const report = await examine(disk,{...lib,identity:{...lib.identity,managed:safe}},skeleton);
	manual.push(...report.manual);
	for (const item of report.repairs) {
		const binding = safe.find(binding=>binding.path === item.file);
		if (!binding || item.before !== binding.fingerprint) continue;
		const original = await fs.readFile(await disk.path(lib.location + '/' + item.file),'utf8');
		if (digest(original) !== item.before) throw new Error(tr('受管文件已变化，请重新预览','A managed file changed. Preview again') + ' · ' + item.file);
		changes.push({...item,before:item.before,original});
	}
	return {changes,manual};
}

export interface ImportPreview {
	registry:RegistrySnapshot; library:Library; clashes:Library[]; missing?:Library;
	rebinding:Awaited<ReturnType<typeof prepareRebinding>>;
}

export async function previewImport(disk:VaultDisk, config:Config, location:string,
	assets:(lib:Library)=>Record<string,string>, missing?:{location:string;id?:string}):Promise<ImportPreview> {
	const registry = await readVaultRegistry(disk);
	const library = await registryCandidate(disk,config,location);
	if (!library || library.problem || (!library.identity && !library.mapping)) {
		throw new Error(library?.problem ?? tr('请选择有效的知识库 kb.toml','Choose a valid library kb.toml'));
	}
	const registered = await discover(disk,config);
	const missingEntry = missing ? registered.find(lib=>lib.location === missing.location && lib.missing) : undefined;
	if (missing && (!missingEntry || !library.identity || (missing.id && library.identity.id !== missing.id))) {
		throw new Error(tr('此清单的 ID 或原登记状态与失联库不匹配','The ID or registered state differs from the missing library'));
	}
	const clashes = library.identity ? registered.filter(lib=>lib.location !== library.location && lib.identity?.id === library.identity?.id) : [];
	return {registry,library,clashes,missing:missingEntry,rebinding:await prepareRebinding(disk,library,assets(library))};
}

export type ImportMode = 'register'|'rebind'|'copy'|'copy-rebind';

export async function confirmImport(disk:VaultDisk, config:Config, preview:ImportPreview, mode:ImportMode,
	assets:(lib:Library)=>Record<string,string>, files:VisibleFiles) {
	const {library,missing,registry} = preview;
	const rebind = mode === 'rebind' || mode === 'copy-rebind';
	const copy = mode === 'copy' || mode === 'copy-rebind';
	if (copy && (!library.identity || (!preview.clashes.length && !missing))) throw new Error(tr('无法确认副本身份','No matching original to confirm the copy'));
	if (rebind && (!preview.rebinding.changes.length || (!copy && preview.clashes.length))) throw new Error(tr('没有可安全重绑的文件','No eligible files to rebind'));
	if (!copy && missing && preview.clashes.length) throw new Error(tr('所选库的 ID 已在其他登记位置使用','The selected ID is already registered at another path'));
	const paths = amendRegistry(registry.paths,{add:[library.location],remove:missing && !copy ? [missing.location] : []},disk.configDir);
	await writeVaultRegistry(disk,registry.raw,paths,async()=>{
		const latest = await previewImport(disk,config,library.location,assets,missing && {location:missing.location,id:library.identity?.id});
		if (JSON.stringify(latest) !== JSON.stringify(preview)) throw new Error(tr('导入目标或预览已变化，请重新查看','The library or import preview changed. Review again'));
		if ((!copy && !rebind) || !library.identity || !library.signature) return;
		const manifest = await readManifestFile(await disk.path(library.location + '/' + identityFile));
		if (manifest.signature !== library.signature) throw new Error(tr('清单已变化，请重新预览','Manifest changed. Preview again'));
		const changes = rebind ? preview.rebinding.changes : [];
		const bindings = new Map(changes.map(item=>[item.file,item]));
		const identity = {...library.identity,id:copy ? randomUUID() : library.identity.id,
			managed:library.identity.managed.map(item=>{
				const changed = bindings.get(item.path);
				return changed ? {...item,root:library.location,fingerprint:digest(changed.after)} : item;
			})};
		const after = writeIdentity(manifest.raw,identity);
		const written:Rebinding[] = [];
		try {
			for (const item of changes) {
				await files.replace(library.location + '/' + item.file,item.before,item.after);
				written.push(item);
			}
			await replaceLibraryManifest(disk,library.location,manifest.signature,after);
		} catch (error) {
			const rollback = await Promise.allSettled(written.map(item=>files.replace(library.location + '/' + item.file,digest(item.after),item.original)));
			const failures = rollback.flatMap((result,index)=>result.status==='rejected' ? [written[index]!.file + ' · ' + String(result.reason)] : []);
			if (failures.length) throw new Error(String(error) + '\n' + tr('这些绑定需要人工复核','These bindings need manual review') + '\n' + failures.join('\n'));
			throw error;
		}
	});
}
