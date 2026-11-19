import { MarkdownView, moment } from 'obsidian';
import type { App, TFile } from 'obsidian';
import { tr } from '../i18n.ts';
import type { Identity } from '../kb/identity-core.ts';
import { bindSharedKepanoPage } from '../kb/kepano.ts';
import { insertTemplate } from '../kb/insert.ts';
import type { Mapping } from '../kb/mapping.ts';
import { kepanoBinding, sharedTemplateKind } from '../kb/template-core.ts';
import { checkTemplateFile, legacyTemplateFolder, listTemplateFiles, localTemplateFolder, previewTemplateRestore, restoreTemplateFile } from '../kb/template-files.ts';
import type { Preset, TemplateAccess } from '../kb/template-files.ts';
import { compareRegistryPaths } from '../registry/paths.ts';
import { Dialog } from './dialog.ts';

interface InsertionScope {
	location: string;
	template: Identity['template'];
	mapping?: Mapping;
	assets: { wiki: Record<string, string>; kepano: Record<string, string> };
	checkPath?: TemplateAccess['checkPath'];
	confirm(action: () => Promise<void>): Promise<void>;
	recordRestored(files: Preset[]): Promise<void>;
	reopen(): Promise<void>;
}

function changed() {
	return new Error(tr('目标或模板已变化，请重新预览', 'Target or template changed. Preview again.'));
}

export async function chooseInsertion(app: App, view: MarkdownView, target: TFile, scope: InsertionScope) {
	const { location, template } = scope;
	const { adapter: disk, configDir } = app.vault;
	const access = { disk, configDir, checkPath: scope.checkPath };
	const targetPath = target.path;
	const currentView = () => view === app.workspace.getActiveViewOfType(MarkdownView)
		&& view.file === target && target.path === targetPath;
	await checkTemplateFile(access, targetPath, location);
	const kind = sharedTemplateKind(template);
	let local = '', localWarning = '';
	try { local = localTemplateFolder(location, template.id, scope.mapping); }
	catch (error) {
		if (!kind) throw error;
		localWarning = String(error);
	}
	const assets = kind === 'kepano' ? scope.assets.kepano : scope.assets.wiki;
	async function shared() {
		if (!kind) return { folder: '', files: new Set<string>(), warning: '' };
		try {
			const folder = await legacyTemplateFolder(access, kind);
			return { folder, files: await listTemplateFiles(access, folder, ''), warning: '' };
		} catch (error) {
			return { folder: '', files: new Set<string>(), warning: tr('无法读取旧版共享模板：', 'Cannot read legacy shared templates: ') + String(error) };
		}
	}
	const legacy = await shared();
	let localFiles = new Set<string>();
	if (local) {
		try { localFiles = await listTemplateFiles(access, local, location); }
		catch (error) {
			if (!kind) throw error;
			localWarning = String(error);
			local = '';
		}
	}
	const files = [
		...Array.from(localFiles).sort(compareRegistryPaths).map(name => ({ path: local + '/' + name, name, shared: false })),
		...Array.from(legacy.files).sort(compareRegistryPaths)
			.map(name => ({ path: legacy.folder + '/' + name, name, shared: true })),
	].filter(file => /\.md$/iu.test(file.name) && file.path !== targetPath);

	const dialog = new Dialog(app, tr('插入本库页面模板', 'Insert library template'));
	dialog.lines([targetPath, ...[local, localWarning, legacy.warning].filter(Boolean)]);
	if (kind && local) {
		let missing: Preset[] = [];
		try { missing = await previewTemplateRestore(access, kind, location, local, assets, legacy.files); }
		catch (error) { dialog.lines([tr('无法预览本库模板恢复：', 'Cannot review library template restoration: ') + String(error)]); }
		if (missing.length) dialog.action(tr('预览恢复缺失模板', 'Review restoration of missing templates'), () => {
			const review = new Dialog(app, tr('恢复模板到本库', 'Restore templates to this library'));
			const bindings = kind === 'kepano' && missing.some(file =>
				file.path === location + '/' + file.bundledPath && kepanoBinding(assets, file.bundledPath));
			review.lines([...missing.map(file => file.path), ...(bindings ?
				[tr('在清单中登记恢复的受管链接', 'Record restored managed links in the manifest') + ' · ' + location + '/kb.toml'] : [])]);
			review.action(tr('恢复所列模板', 'Restore listed templates'), async () => {
				await scope.confirm(async () => {
					const latest = await shared();
					const refreshed = await previewTemplateRestore(access, kind, location, local, assets, latest.files);
					if (latest.folder !== legacy.folder || latest.warning !== legacy.warning || JSON.stringify(refreshed) !== JSON.stringify(missing))
						throw changed();
					// A failed copy leaves a declared missing file eligible for a confirmed retry.
					await scope.recordRestored(missing);
					for (const preset of missing) await restoreTemplateFile(access, preset, location);
				});
				review.close();
				dialog.close();
				if (currentView()) await scope.reopen();
			});
			review.open();
			return Promise.resolve();
		});
	}
	let selected = files[0]?.path;
	if (!selected) {
		dialog.lines([tr('没有可插入的页面模板', 'No page templates are available')]);
		dialog.open();
		return;
	}
	dialog.choice(tr('页面模板', 'Page template'), Object.fromEntries(files.map(file => [file.path,
		file.name + (file.shared ? tr('（旧版共享）', ' (legacy shared)') : '')])), value => { selected = value; });
	dialog.action(tr('预览插入', 'Preview insertion'), async () => {
		const file = files.find(candidate => candidate.path === selected);
		if (!file || !currentView()) throw changed();
		async function checkSource() {
			if (!file) throw changed();
			if (file.shared && (!kind || await legacyTemplateFolder(access, kind) !== legacy.folder)) throw changed();
			await checkTemplateFile(access, file.path, file.shared ? '' : location);
		}
		await checkSource();
		const sourceText = await disk.read(file.path);
		const source = file.shared && kind === 'kepano' ? bindSharedKepanoPage(file.name, sourceText, location, assets) : sourceText;
		const editor = view.editor, note = editor.getValue(), now = moment();
		const result = insertTemplate(note, source, editor.posToOffset(editor.getCursor()), target.basename,
			(kind, pattern) => now.format(pattern || (kind === 'date' ? 'YYYY-MM-DD' : 'HH:mm')));
		const preview = new Dialog(app, tr('预览插入', 'Preview insertion'));
		preview.lines([targetPath, file.path, ...result.conflicts.map(key => tr('保留现有属性：', 'Keep existing property: ') + key)]);
		preview.contentEl.createEl('pre', { text: result.text });
		preview.action(tr('插入', 'Insert'), async () => {
			await scope.confirm(async () => {
				await checkTemplateFile(access, targetPath, location);
				await checkSource();
				if (await disk.read(file.path) !== sourceText || !currentView() || view.editor !== editor || editor.getValue() !== note) throw changed();
				editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: editor.offsetToPos(note.length), text: result.text }] });
				editor.setCursor(editor.offsetToPos(result.cursor));
			});
			preview.close();
			dialog.close();
		});
		preview.open();
	});
	dialog.open();
}
