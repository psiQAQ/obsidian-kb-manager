import { MarkdownView } from 'obsidian';
import type { TFile } from 'obsidian';
import { tr } from '../i18n.ts';
import { identityFile, writeIdentity } from '../kb/identity-core.ts';
import { restoredTemplateBindings } from '../kb/template-files.ts';
import { chooseInsertion } from '../ui/template-picker.ts';
import { hash, replaceText } from './disk.ts';
import { discoverMobile } from './registration.ts';
import type MobilePlugin from './plugin.ts';

async function choose(plugin: MobilePlugin, view: MarkdownView, target: TFile) {
	const lib = (await discoverMobile(plugin.ctx)).find(item => target.path.startsWith(item.location + '/'));
	if (!lib?.identity || !lib.manifest || lib.problem || lib.duplicate || lib.identity.archived) {
		throw new Error(tr('请选择可写知识库中的笔记', 'Select a note in a writable library'));
	}
	const identity = lib.identity, manifest = lib.manifest;
	await chooseInsertion(plugin.app, view, target, {
		location: lib.location, template: identity.template, mapping: lib.mapping, assets: plugin.templates,
		confirm: action => plugin.catalogWrite(async () => {
			const current = (await discoverMobile(plugin.ctx)).find(item => item.location === lib.location);
			if (!current?.identity || current.duplicate || current.problem || current.manifest !== manifest) {
				throw new Error(tr('知识库已变化，请重新预览', 'The library changed. Preview again.'));
			}
			await action();
		}),
		async recordRestored(files) {
			const managed = await restoredTemplateBindings(identity, files, lib.location, plugin.templates.kepano, hash);
			if (!managed) return;
			await replaceText(plugin.ctx.disk, lib.location + '/' + identityFile, manifest,
				writeIdentity(manifest, { ...identity, managed }));
		},
		reopen: () => choose(plugin, view, target),
	});
}

export function registerMobileTemplates(plugin: MobilePlugin) {
	plugin.addCommand({ id: 'insert-library-template', name: tr('插入本库页面模板', 'Insert library template'), editorCallback: async () => {
		const view = plugin.app.workspace.getActiveViewOfType(MarkdownView), target = view?.file;
		if (!view || !target) return;
		try { await choose(plugin, view, target); } catch (error) { plugin.report(error); }
	} });
}
