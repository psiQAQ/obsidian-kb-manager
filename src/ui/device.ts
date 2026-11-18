import { Notice, apiVersion } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';

export function gitDisabled(plugin: KnowledgeBaseManager): boolean {
	return plugin.app.loadLocalStorage(plugin.manifest.id + ':gitDisabled') === true;
}

export async function setDeviceGitDisabled(plugin: KnowledgeBaseManager, disabled: boolean) {
	plugin.app.saveLocalStorage(plugin.manifest.id + ':gitDisabled',disabled);
	await plugin.refresh();
}

export function assertGitEnabled(plugin: KnowledgeBaseManager) {
	if (gitDisabled(plugin)) throw new Error(plugin.t('本设备的知识库 Git 已暂停，可在高级设置中恢复。','Library Git is paused on this device. Resume it in Advanced settings.'));
}

export function pluginNotice(plugin: KnowledgeBaseManager, kind: 'info'|'unchanged'|'error', message: string, id?: string, timeout?: number) {
	const prefs = plugin.preferences(id);
	const enabled = kind === 'error' ? prefs.showErrorNotices : prefs.showInfoNotices && (kind !== 'unchanged' || prefs.showNoChangesNotices);
	if (enabled) new Notice(message,timeout);
}

export function diagnostics(plugin: KnowledgeBaseManager,id?: string) {
	const prefs = plugin.preferences(id);
	return {
		plugin:plugin.manifest.id, version:plugin.manifest.version, obsidian:apiVersion,
		platform:process.platform, language:plugin.prefs.language, backend:prefs.backend,
		pausedOnDevice:gitDisabled(plugin), registeredParents:plugin.config.parents.length,
		registeredTemplates:plugin.config.templates.length, knownLibraries:Object.keys(plugin.known).length,
		authorizedLibraries:Object.keys(plugin.grants).length,
	};
}
