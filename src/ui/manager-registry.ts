import { FuzzySuggestModal, Notice, Setting, TFile, TFolder } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { identityFile } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { applyIgnoreRule, previewIgnoreRule, previewRegistryIgnore, readRegistryRaw, readVaultRegistry, writeVaultRegistry } from '../registry/desktop.ts';
import { registryCandidate, scanVaultFolder } from '../registry/discovery.ts';
import { confirmImport, previewImport } from '../registry/import.ts';
import type { ImportMode } from '../registry/import.ts';
import { amendRegistry, parseRegistry, registryIgnoreRule, registryPath } from '../registry/paths.ts';
import { Dialog } from './dialog.ts';
import { reviewRegistryProtection } from './registry-ignore.ts';
import { gitDisabled } from './device.ts';
import { visible } from './maintain.ts';
import { gitResult } from '../git/network-native.ts';

function choose<T>(plugin:KnowledgeBaseManager, title:string, items:T[], label:(v:T)=>string, run:(v:T)=>Promise<void>) {
	class Picker extends FuzzySuggestModal<T> {
		getItems(){return items;}
		getItemText(value:T){return label(value);}
		onChooseItem(value:T){void run(value).catch(error=>new Notice(String(error),8000));}
	}
	const picker = new Picker(plugin.app);
	picker.setPlaceholder(title);
	picker.open();
}

function descriptions(plugin:KnowledgeBaseManager, lib:Library) {
	const {t} = plugin;
	const entry = lib.identity?.entry ?? lib.mapping?.index;
	return [
		lib.location + '/' + identityFile,
		'ID · ' + (lib.identity?.id ?? t('旧库，尚未分配','Legacy library, unassigned')),
		t('首页','Homepage') + ' · ' + (entry ? lib.location + '/' + entry : t('未设置','None')),
		t('Git 偏好覆盖','Git preferences overrides') + ' · ' + (Object.entries(lib.preferences ?? {}).map(([key,value])=>key + '=' + JSON.stringify(value)).join(', ') || t('无','None')),
	];
}

function pickManifest(plugin:KnowledgeBaseManager, run:(location:string)=>Promise<void>) {
	const items = plugin.app.vault.getFiles().filter(f=>f.name === identityFile && f.parent && f.parent.path !== '/');
	if (!items.length) {
		new Notice(plugin.t('当前 Vault 中没有可选择的 kb.toml','There is no kb.toml to select in this Vault'));
		return;
	}
	choose(plugin,plugin.t('选择知识库的 kb.toml','Select the library kb.toml'),items,f=>f.path,async f=>{
		if (!(plugin.app.vault.getAbstractFileByPath(f.path) instanceof TFile) || !f.parent) throw new Error(plugin.t('文件已变化，请重新选择','File changed. Select it again.'));
		await run(f.parent.path);
	});
}

export async function showImportPreview(plugin:KnowledgeBaseManager, location:string, missing?:{location:string;id?:string}) {
	const {t,disk,config} = plugin;
	const assets = (lib:Library)=>plugin.templateAssets(lib);
	const preview = await previewImport(disk,config,location,assets,missing);
	const dialog = new Dialog(plugin.app,missing ? t('重新定位已登记知识库','Relocate registered library') : t('预览知识库导入','Preview library import'));
	const protect=await reviewRegistryProtection(plugin,dialog);
	dialog.lines([
		...descriptions(plugin,preview.library), registryPath,
		...(missing ? [missing.location + ' → ' + location,...(missing.id ? [] : [t('此前没有记录该库的 ID，请核对所选库的身份。','The previous ID is unavailable. Verify the selected library identity.')])] : []),
		...preview.clashes.map(lib=>t('登记中已有同 ID','Same ID already registered') + ' · ' + lib.location),
		...preview.rebinding.changes.flatMap(change=>[change.file,...change.fields]),
		...preview.rebinding.manual,
	]);
	if (preview.library.identity) {
		try {
			const rule = await previewIgnoreRule(disk,location,'/' + identityFile);
			if (rule.before !== rule.after) {
				dialog.lines([t('可添加本库 Git 忽略规则','Library ignore rule available') + ' · ' + location + '/.gitignore',rule.rule]);
				dialog.action(t('确认写入本库忽略规则','Write library ignore rule'),async()=>{
					await plugin.exclusive(location,()=>applyIgnoreRule(disk,rule));
					dialog.close();
					await showImportPreview(plugin,location,missing);
				});
			}
		} catch (error) { dialog.lines([String(error)]); }
	if (!gitDisabled(plugin) && preview.library.git === 'local') {
			try {
				const tracked = (await gitResult(await disk.path(location),['ls-files','-z','--',identityFile])).stdout.length > 0;
				if (tracked) dialog.lines([t('本库 Git 已跟踪 kb.toml。已有索引记录需要另行处理。','Git tracks kb.toml. Review the existing index entry separately.')]);
			} catch (error) { dialog.lines([t('无法读取 kb.toml 的 Git 跟踪状态','Unable to read the Git tracking status for kb.toml') + ' · ' + String(error)]); }
		}
	}
	const apply = (mode:ImportMode)=>async()=>{
		await plugin.exclusive(location,async()=>{
			await protect();
			await confirmImport(disk,plugin.config,preview,mode,assets,visible(plugin));
		});
		dialog.close();
		await plugin.refresh();
	};
	const hasChanges = preview.rebinding.changes.length > 0;
	if (preview.clashes.length || missing) {
		if (!missing) dialog.action(t('登记并保留重复 ID','Register and retain duplicate ID'),apply('register'));
		dialog.action(t('作为副本登记并分配新 ID','Register as a copy and assign a new ID'),apply('copy'));
		if (hasChanges) dialog.action(t('分配新 ID 并重绑','Assign a new ID and rebind'),apply('copy-rebind'));
	}
	if (!preview.clashes.length) {
		const existing = preview.registry.paths.includes(location);
		if (!existing || missing) dialog.action(missing ? t('确认重新定位','Confirm relocation') : t('登记到列表','Register library'),apply('register'));
		if (hasChanges) dialog.action(t('确认登记及重绑','Register and rebind'),apply('rebind'));
		if (existing && !hasChanges && !missing) dialog.lines([t('此库已登记。','This library is registered.')]);
	}
	dialog.open();
}

export function relocateRegistryEntry(plugin:KnowledgeBaseManager, location:string) {
	const id = Object.entries(plugin.known).find(([,previous])=>location === previous)?.[0];
	pickManifest(plugin,next=>showImportPreview(plugin,next,{location,id}));
}

export async function removeRegistryEntry(plugin:KnowledgeBaseManager, location:string) {
	const {t,disk} = plugin;
	const {raw,paths} = await readVaultRegistry(disk);
	if (!paths.includes(location)) throw new Error(t('登记已变化，请刷新','Registration changed. Refresh the manager.'));
	const dialog = new Dialog(plugin.app,t('移除登记','Remove registration'));
	dialog.lines([registryPath,location,t('此操作更新 Vault 的登记列表，保留目录和文件。','This updates the Vault registry and preserves the folder and files.')]);
	dialog.action(t('移除登记','Remove registration'),async()=>{
		await plugin.exclusive(location,()=>writeVaultRegistry(disk,raw,amendRegistry(paths,{remove:[location]},disk.configDir)));
		dialog.close();
		await plugin.refresh();
	});
	dialog.open();
}

async function showScanPreview(plugin:KnowledgeBaseManager, location:string) {
	const {t,disk,config} = plugin;
	const raw = await readRegistryRaw(disk);
	let paths:string[] = [];
	let problem:string|undefined;
	try { if (raw !== null) paths = parseRegistry(raw,disk.configDir); }
	catch (error) { problem = String(error); }
	if (problem && location) throw new Error(t('登记文件有误。请选择 Vault 根目录重建。','The registry is invalid. Select the Vault root to rebuild it.') + '\n' + problem);
	const {libraries,skipped} = await scanVaultFolder(disk,config,location);
	const existing = await Promise.all(paths.filter(path=>!libraries.some(lib=>lib.location===path)).map(path=>registryCandidate(disk,config,path)));
	const seen = [...libraries,...existing.filter(lib=>lib!==undefined)];
	const dialog = new Dialog(plugin.app,problem ? t('预览重建登记列表','Preview registry rebuild') : t('预览扫描结果','Preview scan results'));
	const protect=await reviewRegistryProtection(plugin,dialog);
	dialog.lines([location || t('Vault 根目录','Vault root'),registryPath,...(problem ? [problem] : []),...skipped]);
	const selected = new Set<string>();
	for (const lib of libraries) {
		const duplicates = lib.identity ? seen.filter(other=>other.location!==lib.location && other.identity?.id===lib.identity?.id) : [];
		const row = new Setting(dialog.contentEl).setName(lib.identity?.displayName ?? lib.location).setDesc([
			...descriptions(plugin,lib), ...(lib.problem ? [lib.problem] : []),
			...duplicates.map(other=>t('ID 重复','Duplicate ID') + ' · ' + other.location),
		].join('\n'));
		if (lib.problem || (!lib.identity && !lib.mapping)) continue;
		if (paths.includes(lib.location)) { row.descEl.createDiv({text:t('已登记','Registered')}); continue; }
		if (!duplicates.length) selected.add(lib.location);
		row.addToggle(toggle=>toggle.setValue(selected.has(lib.location)).setTooltip(t('登记此知识库','Register this library')).onChange(include=>{
			if (include) selected.add(lib.location);
			else selected.delete(lib.location);
		}));
	}
	if (!libraries.length) dialog.lines([t('没有发现可检查的 kb.toml。','No kb.toml found to review.')]);
	if (problem || libraries.some(lib=>!lib.problem && (lib.identity || lib.mapping) && !paths.includes(lib.location))) {
		dialog.action(problem ? t('用所选条目重建','Rebuild using selected entries') : t('登记所选条目','Register selected entries'),async()=>{
			const additions = [...selected];
			if (!additions.length && !problem) return;
			const next = amendRegistry(paths,{add:additions},disk.configDir);
			await writeVaultRegistry(disk,raw,next,async()=>{
				await protect();
				for (const path of additions) {
					const current = await registryCandidate(disk,plugin.config,path);
					if (!current?.signature || current.problem || current.signature!==libraries.find(lib=>lib.location===path)?.signature) {
						throw new Error(t('知识库已变化，请重新扫描','The library changed. Scan again.') + ' · ' + path);
					}
				}
			});
			dialog.close();
			await plugin.refresh();
		});
	}
	dialog.open();
}

export async function showRegistryIgnorePreview(plugin:KnowledgeBaseManager) {
	const {t,disk} = plugin;
	const preview = await previewRegistryIgnore(disk);
	const dialog = new Dialog(plugin.app,t('预览 Vault Git 忽略规则','Preview Vault Git ignore rule'));
	dialog.lines([t('Vault 根目录 .gitignore','Vault root .gitignore'),registryIgnoreRule]);
	if (preview.after === preview.before) dialog.lines([t('忽略规则已存在。','The ignore rule is in place.')]);
	else dialog.action(t('确认写入规则','Write ignore rule'),async()=>{await applyIgnoreRule(disk,preview);dialog.close();});
	dialog.open();
}

export function manageRegistry(plugin:KnowledgeBaseManager) {
	const {t} = plugin;
	const dialog = new Dialog(plugin.app,t('Vault 知识库登记','Vault library registry'));
	dialog.lines([registryPath]);
	dialog.action(t('选择 kb.toml 并预览导入','Select kb.toml and preview import'),()=>{
		dialog.close();
		pickManifest(plugin,location=>showImportPreview(plugin,location));
		return Promise.resolve();
	});
	dialog.action(t('选择目录并扫描','Choose a folder to scan'),()=>{
		dialog.close();
		const folders = plugin.app.vault.getAllLoadedFiles().filter(f=>f instanceof TFolder).map(f=>f.path);
		choose(plugin,t('选择需要扫描的目录','Choose the folder to scan'),['',...folders.filter(p=>p && p!=='/')],
			path=>path || t('Vault 根目录','Vault root'),path=>showScanPreview(plugin,path));
		return Promise.resolve();
	});
	dialog.action(t('预览 Vault Git 忽略规则','Preview Vault Git ignore rule'),async()=>{await showRegistryIgnorePreview(plugin);dialog.close();});
	dialog.open();
}
