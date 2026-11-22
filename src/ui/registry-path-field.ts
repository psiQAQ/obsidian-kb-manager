import { Notice, Setting, TFile, TFolder, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { tr } from '../i18n.ts';
import { identityFile } from '../kb/identity-core.ts';
import { compareRegistryPaths, registryKey, sameOrBelow, validateRegistryPath, vaultParent, vaultPath } from '../registry/paths.ts';
import type { PluginDataRegistry } from '../registry/plugin-data.ts';
import { Dialog } from './dialog.ts';
import { createPanelTabs } from './panel-tabs.ts';

interface Presentation {
	title?: string;
	initialPath?: string | null;
	onSelect?: (path: string) => void;
	compact?: boolean;
	allowNew?: boolean;
}

interface Options extends Presentation {
	label?: string;
	favorites?: readonly string[];
	destination?: {templates: readonly string[]; registry: PluginDataRegistry};
}

type Mode = 'manifest' | 'folder';
type PathTab = 'browse' | 'favorites' | 'input';
const showPath = (path: string) => path || tr('仓库根目录（/）', 'Vault root (/)');

function pathPolicy(app: App, mode: Mode, options: Options, blocked: readonly string[]) {
	const {vault} = app;
	const root = vault.getRoot();
	const destinationError = () => new Error(tr('请选择模板目录和已有知识库之外的位置', 'Choose a location outside template folders and existing libraries'));
	const folderError = () => new Error(tr('请选择已有目录', 'Choose an existing folder'));
	const manifestError = () => new Error(tr('请选择知识库根目录中的 kb.toml', 'Choose kb.toml at the library root'));
	const templateOrRegistered = (path: string) => blocked.some(prefix => sameOrBelow(registryKey(path), prefix));
	const hasIndexedManifest = (folder: TFolder) => folder.children.some(
		item => item instanceof TFile && registryKey(item.name) === identityFile);

	function usable(folder: TFolder) {
		for (let current: TFolder | null = folder; current; current = current.parent) {
			if (options.destination && hasIndexedManifest(current)) return false;
			if (current.isRoot()) continue;
			try { validateRegistryPath(current.path, vault.configDir); }
			catch { return false; }
			if (templateOrRegistered(current.path)) return false;
		}
		return true;
	}

	async function validate(path: string) {
		if (path) validateRegistryPath(path, vault.configDir);
		if (templateOrRegistered(path)) throw destinationError();
		if (mode === 'manifest') {
			if (!path.endsWith('/' + identityFile) || (await vault.adapter.stat(path))?.type !== 'file') throw manifestError();
			return;
		}
		if (!options.destination) {
			if (path && (await vault.adapter.stat(path))?.type !== 'folder') throw folderError();
			return;
		}

		// Check ancestors before accepting a path with missing descendants.
		const parts = path ? path.split('/') : [];
		let ancestor = '';
		for (let index = 0; index <= parts.length; index++) {
			const folder = ancestor ? vault.getFolderByPath(ancestor) : root;
			if (folder && hasIndexedManifest(folder)) throw destinationError();
			if (await vault.adapter.stat(vaultPath(ancestor, identityFile))) throw destinationError();
			const next = parts[index];
			if (!next) return;
			ancestor = vaultPath(ancestor, next);
			const type = (await vault.adapter.stat(ancestor))?.type;
			if (!type && options.allowNew) return;
			if (type !== 'folder') throw folderError();
		}
	}

	return {root, usable, validate};
}

async function openPathPicker(
	app: App, mode: Mode, options: Options, blocked: string[], selected: string | null,
	trigger: HTMLElement, select: (path: string) => void, onClose: () => void,
) {
	const {vault} = app, manifest = mode === 'manifest';
	const {root, usable, validate} = pathPolicy(app, mode, options, blocked);
	const checkedFavorites = await Promise.all((options.favorites ?? []).map(async path => {
		try { await validate(path); return path; }
		catch { return null; }
	}));
	if (!trigger.isConnected) return false;
	const favorites = [...new Set(checkedFavorites.filter(path => path !== null))];
	const selectedFolder = selected ? vault.getFolderByPath(manifest ? vaultParent(selected) : selected) : root;
	const browseSelection = selectedFolder !== null && usable(selectedFolder);
	const initialTab = browseSelection || selected === null ? 'browse' : 'input';
	const initialFolder = browseSelection ? selectedFolder : root;
	const picker = new Dialog(app, options.title ?? (manifest
		? tr('选择知识库清单', 'Choose a library manifest')
		: tr('选择扫描目录', 'Choose a folder to scan')));
	picker.modalEl.addClass('kb-path-picker');
	picker.setCloseCallback(() => {
		onClose();
		queueMicrotask(() => { if (trigger.isConnected) trigger.focus(); });
	});

	const tabs: {id: PathTab; label: string}[] = [{id: 'browse', label: tr('浏览目录', 'Browse folders')}];
	if (favorites.length) tabs.push({id: 'favorites', label: tr('收藏目录', 'Favorite folders')});
	tabs.push({id: 'input', label: tr('输入路径', 'Enter path')});
	const navigation = createPanelTabs(picker.contentEl, tr('选择路径的方式', 'Ways to choose a path'), tabs, initialTab, () => update());
	const {panels} = navigation;

	if(favorites.length)panels.favorites.addClass('kb-path-favorites');
	const candidates: Record<PathTab, string | null> = {
		browse: manifest ? (initialTab === 'browse' ? selected : null) : '',
		favorites: selected !== null && favorites.includes(selected) ? selected : null,
		input: selected,
	};

	const crumbs = panels.browse.createEl('nav', {cls: 'kb-path-crumbs', attr: {'aria-label': tr('目录路径', 'Folder path')}});
	const filterLabel = tr('筛选当前目录', 'Filter this folder');
	const search = panels.browse.createEl('input', {
		cls: 'kb-path-input', placeholder: filterLabel, attr: {type: 'search', 'aria-label': filterLabel},
	});
	const rows = panels.browse.createDiv({cls: 'kb-path-rows'});
	let visibleFolders: TFolder[] = [];
	let manifestInFolder: string | null = null;

	for (const path of favorites) {
		const row = pathRow(panels.favorites, showPath(path), 'star');
		row.setAttribute('aria-pressed', String(candidates.favorites === path));
		row.addEventListener('click', () => {
			candidates.favorites = path;
			panels.favorites.querySelectorAll('button').forEach(favorite => {
				favorite.setAttribute('aria-pressed', String(favorite === row));
			});
			update();
		});
	}

	const inputLabel = manifest ? tr('清单的仓库相对路径', 'Vault-relative manifest path')
		: tr('目录的仓库相对路径', 'Vault-relative folder path');
	let input!: HTMLInputElement;
	new Setting(panels.input).setName(inputLabel).addText(field => {
		input = field.inputEl;
		input.setAttribute('aria-label', inputLabel);
		input.setAttribute('spellcheck', 'false');
		field.setPlaceholder(manifest ? 'library/kb.toml' : 'folder/subfolder');
		field.setValue(selected === '' ? '/' : (selected ?? ''));
		field.onChange(value => {
			candidates.input = !value ? null : (!manifest && value === '/' ? '' : value);
			update();
		});
	});
	if (!manifest) panels.input.createEl('p', {cls: 'kb-path-hint', text: options.allowNew
		? tr('输入 / 可选中仓库根目录。缺失的父目录会在建库时创建。', 'Enter / to select the Vault root. Missing parent folders will be created with the library.')
		: tr('输入 / 可选中仓库根目录。', 'Enter / to select the Vault root.')});

	const footer = picker.contentEl.createDiv({cls: 'kb-path-footer'});
	const candidateLabel = footer.createEl('p', {attr: {role: 'status'}});
	const problem = footer.createEl('p', {cls: 'kb-path-error', attr: {role: 'status'}});
	const actions = footer.createDiv({cls: 'kb-path-actions'});
	actions.createEl('button', {text: tr('取消', 'Cancel'), attr: {type: 'button'}})
		.addEventListener('click', () => picker.close());
	const confirm = actions.createEl('button', {cls: 'mod-cta', attr: {type: 'button'}});
	let revision = 0;

	function update() {
		const tab = navigation.getActive(), path = candidates[tab], current = ++revision;
		candidateLabel.setText(path === null ? tr('尚未选择路径', 'No path selected') : tr('已选位置 · ', 'Selected location · ') + showPath(path));
		confirm.setText(tab === 'input' ? tr('使用输入的路径', 'Use entered path')
			: tab === 'favorites' ? tr('使用所选收藏目录', 'Use selected favorite')
			: manifest ? tr('使用所选清单', 'Use selected manifest')
			: path === '' ? tr('选择仓库根目录', 'Select Vault root') : tr('选择当前目录', 'Select this folder'));
		problem.empty();
		confirm.disabled = true;
		if (path === null) return;
		void validate(path).then(() => {
			if (current === revision) confirm.disabled = false;
		}, error => {
			if (current === revision) problem.setText(error instanceof Error ? error.message : String(error));
		});
	}

	async function accept() {
		const path = candidates[navigation.getActive()];
		if (path === null || confirm.disabled) return;
		const current = ++revision;
		confirm.disabled = true;
		try {
			await validate(path);
			if (current !== revision || !confirm.isConnected) return;
			select(path);
			picker.close();
		} catch (error) {
			if (current === revision) problem.setText(error instanceof Error ? error.message : String(error));
		}
	}
	confirm.addEventListener('click', () => void accept());
	input.addEventListener('keydown', event => {
		if (event.key !== 'Enter' || event.isComposing) return;
		event.preventDefault();
		void accept();
	});

	function renderRows() {
		const query = registryKey(search.value.trim());
		rows.empty();
		if (manifestInFolder && identityFile.includes(query)) {
			const path = manifestInFolder, row = pathRow(rows, identityFile, 'file-text');
			row.setAttribute('aria-pressed', String(candidates.browse === path));
			row.addEventListener('click', () => {
				candidates.browse = path;
				row.setAttribute('aria-pressed', 'true');
				update();
			});
		}
		for (const folder of visibleFolders) {
			if (!registryKey(folder.name).includes(query)) continue;
			const row = pathRow(rows, folder.name, 'folder');
			const chevron = row.createSpan({cls: 'kb-path-chevron', attr: {'aria-hidden': 'true'}});
			setIcon(chevron, 'chevron-right');
			row.addEventListener('click', () => browse(folder, true));
		}
		if (!rows.childElementCount) rows.createEl('p', {text: tr('当前目录没有匹配项', 'No matches in this folder')});
	}
	search.addEventListener('input', renderRows);

	let folderRevision = 0;
	function browse(folder: TFolder, focusSearch = false) {
		const current = ++folderRevision;
		const isRoot = folder.isRoot();
		crumbs.empty();
		const ancestors: TFolder[] = [];
		for (let parent = folder.parent; parent; parent = parent.parent) ancestors.unshift(parent);
		for (const parent of ancestors) {
			crumbs.createEl('button', {text: parent.isRoot() ? showPath('') : parent.name, attr: {type: 'button'}})
				.addEventListener('click', () => browse(parent, true));
			const divider = crumbs.createSpan({attr: {'aria-hidden': 'true'}});
			setIcon(divider, 'chevron-right');
		}
		crumbs.createSpan({text: isRoot ? showPath('') : folder.name, attr: {'aria-current': 'location'}});
		search.value = '';
		visibleFolders = folder.children.filter((item): item is TFolder => item instanceof TFolder && usable(item))
			.sort((a, b) => compareRegistryPaths(a.name, b.name));
		manifestInFolder = null;
		if (!manifest || current !== 1) candidates.browse = manifest ? null : (isRoot ? '' : folder.path);
		renderRows();
		update();
		if (focusSearch) search.focus();
		if (!manifest || isRoot) return;
		const path = vaultPath(folder.path, identityFile);
		void vault.adapter.stat(path).then(stat => {
			if (folderRevision === current && stat?.type === 'file') {
				manifestInFolder = path;
				renderRows();
			}
		}, error => { if (folderRevision === current) problem.setText(error instanceof Error ? error.message : String(error)); });
	}

	browse(initialFolder);
	picker.open();
	navigation.focusActive();
	return true;
}

function pathRow(container: HTMLElement, path: string, icon: string) {
	const row = container.createEl('button', {cls: 'kb-path-row', attr: {type: 'button'}});
	setIcon(row.createSpan({attr: {'aria-hidden': 'true'}}), icon);
	row.createSpan({text: path});
	return row;
}

export function registryPathField(dialog: Pick<Dialog, 'contentEl'>, app: App, mode: Mode, options: Options = {}) {
	let selected = options.initialPath ?? null;
	let opening = false;
	const label = options.label ?? (mode === 'manifest' ? identityFile : tr('扫描目录', 'Folder to scan'));
	const browse = tr('浏览…', 'Browse…');
	const placeholder = mode === 'manifest' ? tr('选择清单', 'Select a manifest') : tr('选择目录', 'Select a folder');
	const row = new Setting(dialog.contentEl).setName(label);
	if (options.compact) row.setClass('kb-path-field-compact');
	if (options.allowNew && !options.compact) row.setDesc(tr('可输入相对路径，并在创建知识库时建立缺失的父目录。',
		'You can enter a relative path and create any missing parent folders with the library.'));
	row.addText(input => {
		input.setPlaceholder(placeholder).setValue(selected === null ? '' : showPath(selected));
		input.inputEl.readOnly = true;
		input.inputEl.setAttribute('aria-label', label);
		input.inputEl.setAttribute('aria-haspopup', 'dialog');
		const open = async (trigger: HTMLElement) => {
			if (opening) return;
			opening = true;
			try {
				const registered = await options.destination?.registry.read();
				const blocked = [...(options.destination?.templates ?? []), ...(registered?.paths ?? [])].map(registryKey);
				opening = await openPathPicker(app, mode, options, blocked, selected, trigger, path => {
					selected = path;
					input.setValue(showPath(path));
					options.onSelect?.(path);
				}, () => { opening = false; });
			} catch (error) { opening = false; new Notice(String(error)); }
		};
		input.inputEl.addEventListener('click', () => void open(input.inputEl));
		input.inputEl.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			void open(input.inputEl);
		});
		row.addButton(button => {
			button.buttonEl.setAttribute('aria-haspopup', 'dialog');
			button.setButtonText(browse).onClick(() => open(button.buttonEl));
		});
	});
	return () => {
		if (selected === null) throw new Error(placeholder);
		return selected;
	};
}

export function destinationParentField(
	dialog: Pick<Dialog, 'contentEl'>, app: App, config: {parents: string[]; templates: string[]}, registry: PluginDataRegistry,
	presentation: boolean | Presentation = false,
) {
	const options = typeof presentation === 'boolean' ? {allowNew: presentation} : presentation;
	return registryPathField(dialog, app, 'folder', {
		label: tr('目标父目录', 'Destination parent folder'), favorites: config.parents,
		title: options.allowNew ? tr('选择新知识库的父目录', 'Choose the new library’s parent folder')
			: tr('选择目标父目录', 'Choose the destination parent folder'),
		destination: {templates: config.templates, registry},
		...options,
	});
}
