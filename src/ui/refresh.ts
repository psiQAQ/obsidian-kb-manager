import { gitDisabled, pluginNotice } from './device.ts';
import type { TAbstractFile } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';

export function watchLibraryChanges(plugin: KnowledgeBaseManager, lib: Library, panel: HTMLElement,
	signal: AbortSignal, refresh: () => Promise<void>) {
	if (!lib.identity || signal.aborted || gitDisabled(plugin)) return;
	const prefs = plugin.preferences(lib.identity.id);
	if (!prefs.refreshSourceControl) return;
	const vault = plugin.app.vault;
	const owner=panel.win;
	const inScope = (path: string) => path === lib.location || path.startsWith(lib.location + '/');
	let timer: number | undefined;
	let pending = false;
	const schedule = () => {
		owner.clearTimeout(timer);
		timer = owner.setTimeout(() => {
			if (signal.aborted || !panel.isConnected) return;
			const focus = panel.ownerDocument.activeElement;
			// Preserve the selection and focus while someone types a commit message.
			if (focus?.matches('textarea, input, [contenteditable="true"]') && panel.contains(focus)) return;
			pending = false;
			void refresh().catch(error => pluginNotice(plugin,'error',String(error),lib.identity?.id));
		},prefs.refreshSourceControlTimer);
	};
	const change = (file: TAbstractFile, previous?: string) => {
		if (inScope(file.path) || (previous && inScope(previous))) {
			pending = true; schedule();
		}
	};
	const resume = () => { if (pending) schedule(); };
	const events = [vault.on('create',change), vault.on('modify',change), vault.on('delete',change), vault.on('rename',change)];
	panel.addEventListener('focusout',resume);
	signal.addEventListener('abort',() => {
		owner.clearTimeout(timer);
		for (const event of events) vault.offref(event);
		panel.removeEventListener('focusout',resume);
	},{once:true});
}
