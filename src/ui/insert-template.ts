import { MarkdownView, Notice } from 'obsidian';
import type { TFile } from 'obsidian';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type KnowledgeBaseManager from '../main.ts';
import { digest } from '../fs/vault.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { identityFile, writeIdentity } from '../kb/identity-core.ts';
import { readManifestFile, replaceLibraryManifest } from '../kb/manifest-disk.ts';
import { restoredTemplateBindings } from '../kb/template-files.ts';
import { tr } from '../i18n.ts';
import { chooseInsertion } from './template-picker.ts';

async function choose(plugin: KnowledgeBaseManager, view: MarkdownView, target: TFile) {
	const lib = (await discover(plugin.disk, plugin.config)).find(item => target.path.startsWith(item.location + '/'));
	if (!lib?.identity || lib.problem || lib.duplicate || lib.identity.archived) {
		throw new Error(tr('请选择可写知识库中的笔记', 'Select a note in a writable library'));
	}
	const root = await fs.realpath(plugin.disk.root);
	const identity = lib.identity;
	await chooseInsertion(plugin.app, view, target, {
		location: lib.location, template: identity.template, mapping: lib.mapping,
		assets: { wiki: plugin.skeleton, kepano: plugin.kepanoSkeleton },
		async checkPath(relative) {
			const stat = await fs.lstat(path.join(root, relative));
			if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) {
				throw new Error(tr('需要目录或独立常规文件', 'Expected a folder or a regular file with one link') + ' · ' + relative);
			}
		},
		confirm: action => plugin.exclusive(lib.location, async () => {
			await recheck(plugin.disk, plugin.config, lib);
			await action();
		}),
		async recordRestored(files) {
			const managed = await restoredTemplateBindings(identity, files, lib.location, plugin.kepanoSkeleton, digest);
			if (!managed) return;
			const raw = await readManifestFile(await plugin.disk.path(lib.location + '/' + identityFile));
			if (raw.signature !== lib.signature) throw new Error(tr('知识库清单已变化，请重新预览', 'Library manifest changed. Preview again.'));
			await replaceLibraryManifest(plugin.disk, lib.location, raw.signature, writeIdentity(raw.raw, { ...identity, managed }));
		},
		reopen: () => choose(plugin, view, target),
	});
}

export function registerLibraryTemplates(plugin: KnowledgeBaseManager) {
	plugin.addCommand({ id: 'insert-library-template', name: tr('插入本库页面模板', 'Insert library template'), editorCallback: async () => {
		const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;
		try { await choose(plugin, view, view.file); } catch (error) { new Notice(String(error)); }
	} });
}
