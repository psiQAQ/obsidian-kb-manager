import { Setting } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { identityFile } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { applyIgnoreRule, previewIgnoreRule, previewRegistryIgnore, readRegistryRaw, readVaultRegistry, writeVaultRegistry } from '../registry/desktop.ts';
import { registryCandidate, scanVaultFolder } from '../registry/discovery.ts';
import { confirmImport, previewImport } from '../registry/import.ts';
import type { ImportMode } from '../registry/import.ts';
import { amendRegistry, parseRegistry, registryDataPath, vaultParent } from '../registry/paths.ts';
import { V3Dialog as Dialog, dialogContents } from './dialog.ts';
import { reviewRegistryProtection } from './registry-ignore.ts';
import { registryPathField } from './registry-path-field.ts';
import { gitDisabled } from './device.ts';
import { visible } from './maintain.ts';
import { gitResult } from '../git/network-native.ts';
import { createPanelTabs } from './panel-tabs.ts';

function libraryFacts(plugin:KnowledgeBaseManager, lib:Library) {
	const {t} = plugin;
	const entry = lib.identity?.entry ?? lib.mapping?.index;
	return [
		[t('清单','Manifest'),lib.location + '/' + identityFile],
		[t('知识库 ID','Library ID'),lib.identity?.id ?? t('旧版清单，尚未接管','Legacy manifest, awaiting adoption')],
		[t('首页','Homepage'),entry ? lib.location + '/' + entry : t('未设置','None')],
		[t('本库 Git 设置覆盖','Library Git overrides'),Object.entries(lib.preferences ?? {}).map(([key,value])=>key + '=' + JSON.stringify(value)).join(', ') || t('无','None')],
	] as const;
}

function manifestField(plugin:KnowledgeBaseManager, content:HTMLElement) {
	const getPath = registryPathField({contentEl:content},plugin.app,'manifest');
	return ()=>vaultParent(getPath());
}

export async function showImportPreview(plugin:KnowledgeBaseManager, location:string, missing?:{location:string;id?:string}, complete?:()=>void,owner:Window=activeWindow) {
	const {t,disk,config} = plugin;
	const assets = (lib:Library)=>plugin.templateAssets(lib);
	const preview = await previewImport(disk,config,location,assets,missing);
	const dialog = new Dialog(plugin.app,missing ? t('预览重新定位','Preview relocation') : t('预览知识库登记','Preview library registration'),owner);
	const existing = preview.registry.paths.includes(location);
	dialog.facts([
		...libraryFacts(plugin,preview.library),
		[t('Vault 登记文件','Vault registry file'),registryDataPath(disk.configDir)],
		[t('登记状态','Registration'),existing ? t('此路径已登记','This path is registered') : t('此路径尚未登记','This path is unregistered')],
		...(missing ? [[t('失联路径','Missing path'),missing.location],[t('找到的路径','Located path'),location]] as const : []),
	]);
	if(missing && !missing.id)dialog.lines([t('此前没有记录该库的 ID，请核对所选库的身份。','The previous ID is unavailable. Verify the selected library identity.')]);
	if(!preview.library.identity)dialog.lines([t('登记现有路径后，可在侧栏预览接管并给旧库分配身份。','After registering this path, use Preview adoption in the sidebar to assign the legacy library an identity.')]);
	const protect=await reviewRegistryProtection(plugin,dialog);
	if(preview.clashes.length){
		dialog.contentEl.createEl('h3',{text:t('已登记的同 ID 路径','Registered paths with this ID')});
		dialog.lines(preview.clashes.map(lib=>lib.location));
	}
	const hasChanges = preview.rebinding.changes.length > 0;
	if(hasChanges){
		dialog.contentEl.createEl('h3',{text:t('重绑后的受管文件','Managed files after rebinding')});
		dialog.lines([t('重绑会更新下方受管文件和 kb.toml 中记录的绑定路径。','Rebinding updates the following managed files and the binding paths recorded in kb.toml.')]);
		for(const change of preview.rebinding.changes){
			const item=dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
			item.createEl('summary',{text:location+'/'+change.file});
			dialogContents(item).lines(change.fields);
			item.createEl('pre',{cls:'kb-v3-code'}).createEl('code',{text:change.after});
		}
	}
	if(preview.rebinding.manual.length){
		dialog.contentEl.createEl('h3',{text:t('需人工核对','Manual review required')});
		dialog.lines(preview.rebinding.manual);
	}
	if (preview.library.identity) {
		try {
			const rule = await previewIgnoreRule(disk,location,'/' + identityFile);
			if (rule.before !== rule.after) {
				dialog.lines([t('可添加本库 Git 忽略规则','Library ignore rule available') + ' · ' + location + '/.gitignore',rule.rule]);
				dialog.action(t('确认写入本库忽略规则','Write library ignore rule'),async()=>{
					await plugin.exclusive(location,()=>applyIgnoreRule(disk,rule));
					dialog.close();
					await showImportPreview(plugin,location,missing,complete,owner);
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
		await plugin.exclusive(location,()=>confirmImport(disk,plugin.config,preview,mode,assets,visible(plugin),protect));
		dialog.close();
		complete?.();
		await plugin.refresh();
	};
	if (preview.clashes.length || missing) {
		if (!missing && !existing) dialog.action(t('登记并保留重复 ID','Register and retain duplicate ID'),apply('register'));
		dialog.lines([t('作为副本会在所选目录的 kb.toml 写入新 ID。','Registering as a copy writes a new ID to kb.toml in the selected folder.')]);
		dialog.action(t('作为副本登记并分配新 ID','Register as a copy and assign a new ID'),apply('copy'));
		if (hasChanges) dialog.action(t('登记副本并重绑','Register copy and rebind'),apply('copy-rebind'));
	}
	if (!preview.clashes.length) {
		if (!existing || missing) dialog.action(missing ? t('仅更新登记路径','Update registered path only') : t('仅登记路径','Register path only'),apply('register')).setCta();
		if (hasChanges) dialog.action(missing ? t('更新路径并重绑','Update path and rebind') : existing ? t('重绑受管文件','Rebind managed files') : t('登记路径并重绑','Register path and rebind'),apply('rebind'));
	}
	dialog.open();
}

export function relocateRegistryEntry(plugin:KnowledgeBaseManager, location:string, owner:Window=activeWindow) {
	const id = plugin.previousLibraryId(location);
	const {t,app} = plugin;
	const dialog = new Dialog(app,t('重新定位已登记知识库','Relocate registered library'),owner);
	dialog.facts([[t('失联路径','Missing path'),location],[t('原知识库 ID','Previous library ID'),id ?? t('暂无记录','Unavailable')]]);
	const selected = manifestField(plugin,dialog.contentEl);
	dialog.action(t('预览重新定位','Preview relocation'),()=>showImportPreview(plugin,selected(),{location,id},()=>dialog.close(),owner)).setCta();
	dialog.open();
}

export async function removeRegistryEntry(plugin:KnowledgeBaseManager, location:string,owner:Window=activeWindow) {
	const {t,disk} = plugin;
	const {raw,paths} = await readVaultRegistry(disk);
	if (!paths.includes(location)) throw new Error(t('登记已变化，请刷新','Registration changed. Refresh the manager.'));
	const dialog = new Dialog(plugin.app,t('移除登记','Remove registration'),owner);
	dialog.facts([[t('登记路径','Registered path'),location],[t('Vault 登记文件','Vault registry file'),registryDataPath(disk.configDir)]]);
	dialog.lines([t('此操作从列表移除此知识库，保留目录和文件。','This removes the library from the list and preserves the folder and files.')]);
	dialog.action(t('移除登记','Remove registration'),async()=>{
		await plugin.exclusive(location,()=>writeVaultRegistry(disk,raw,amendRegistry(paths,{remove:[location]},disk.configDir)));
		dialog.close();
		await plugin.refresh();
	});
	dialog.open();
}

async function showScanPreview(plugin:KnowledgeBaseManager, location:string, complete:()=>void,owner:Window) {
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
	const dialog = new Dialog(plugin.app,problem ? t('预览重建登记列表','Preview registry rebuild') : t('预览扫描结果','Preview scan results'),owner);
	const protect=await reviewRegistryProtection(plugin,dialog);
	dialog.facts([[t('扫描目录','Scanned folder'),location || t('Vault 根目录','Vault root')],
		[t('Vault 登记文件','Vault registry file'),registryDataPath(disk.configDir)]]);
	if(problem)dialog.lines([problem]);
	if(skipped.length){
		const details=dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
		details.createEl('summary',{text:t('已跳过的路径','Skipped paths')+' ('+skipped.length+')'});
		dialogContents(details).lines(skipped);
	}
	const selected = new Set<string>();
	for (const lib of libraries) {
		const duplicates = lib.identity ? seen.filter(other=>other.location!==lib.location && other.identity?.id===lib.identity?.id) : [];
		const row = new Setting(dialog.contentEl).setName(lib.identity?.displayName ?? lib.location).setDesc([
			...libraryFacts(plugin,lib).map(([label,value])=>label+' · '+value), ...(lib.problem ? [lib.problem] : []),
			...duplicates.map(other=>t('ID 重复','Duplicate ID') + ' · ' + other.location),
		].join('\n'));
		if (lib.problem || (!lib.identity && !lib.mapping)) continue;
		if (paths.includes(lib.location)) { row.descEl.createDiv({text:t('已登记','Registered')}); continue; }
		if (!duplicates.length) selected.add(lib.location);
		row.addToggle(toggle=>toggle.setValue(selected.has(lib.location)).setTooltip(t('登记此知识库','Register this library')+' · '+lib.location).onChange(include=>{
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
				for (const path of additions) {
					const current = await registryCandidate(disk,plugin.config,path);
					if (!current?.signature || current.problem || current.signature!==libraries.find(lib=>lib.location===path)?.signature) {
						throw new Error(t('知识库已变化，请重新扫描','The library changed. Scan again.') + ' · ' + path);
					}
				}
				await protect();
			});
			dialog.close();
			complete();
			await plugin.refresh();
		}).setCta();
	}
	dialog.open();
}

export async function showRegistryIgnorePreview(plugin:KnowledgeBaseManager,owner:Window=activeWindow) {
	const {t,disk} = plugin;
	const preview = await previewRegistryIgnore(disk);
	const dialog = new Dialog(plugin.app,t('预览 Vault Git 忽略规则','Preview Vault Git ignore rule'),owner);
	dialog.lines([t('Vault 根目录 .gitignore','Vault root .gitignore'),preview.rule]);
	if (preview.after === preview.before) dialog.lines([t('忽略规则已存在。','The ignore rule is in place.')]);
	else dialog.action(t('确认写入规则','Write ignore rule'),async()=>{await applyIgnoreRule(disk,preview);dialog.close();});
	dialog.open();
}

export function manageRegistry(plugin:KnowledgeBaseManager,owner:Window=activeWindow) {
	const {t} = plugin;
	const dialog = new Dialog(plugin.app,t('登记已有知识库','Register existing libraries'),owner);
	const {panels}=createPanelTabs(dialog.contentEl,t('登记方式','Registration method'),[
		{id:'manifest',label:t('选择单个清单','Select one manifest')},
		{id:'scan',label:t('扫描目录','Scan a folder')},
	]);
	const selected=manifestField(plugin,panels.manifest);
	dialogContents(panels.manifest).action(t('预览登记','Preview registration'),()=>showImportPreview(plugin,selected(),undefined,()=>dialog.close(),owner)).setCta();
	const folder=registryPathField({contentEl:panels.scan},plugin.app,'folder',{favorites:plugin.config.parents});
	dialogContents(panels.scan).action(t('扫描并查看结果','Scan and review results'),()=>showScanPreview(plugin,folder(),()=>dialog.close(),owner)).setCta();
	const options=dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
	options.createEl('summary',{text:t('Vault Git 忽略规则','Vault Git ignore rule')});
	options.createEl('p',{text:t('登记列表保存在 '+registryDataPath(plugin.disk.configDir)+'。可将它加入 Vault 的 .gitignore。',
		'The registry is stored in '+registryDataPath(plugin.disk.configDir)+'. You can add it to the Vault .gitignore.')});
	dialogContents(options).action(t('预览忽略规则','Preview ignore rule'),()=>showRegistryIgnorePreview(plugin,owner));
	dialog.open();
}
