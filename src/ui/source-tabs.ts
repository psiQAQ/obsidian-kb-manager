import type { Workspace } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';

interface SourceTabState {
	id: string;
	file?: string;
	staged?: boolean;
	commit?: string;
	parent?: string;
}

function tabKey(type: string, state: Partial<SourceTabState>) {
	return JSON.stringify([type, state.id, state.file, state.commit ?? state.staged, state.parent]);
}

const opening = new WeakMap<Workspace, Map<string, Promise<void>>>();

export function revealSourceTab(plugin: KnowledgeBaseManager, type: string, state: SourceTabState): Promise<void> {
	const {workspace} = plugin.app;
	const key = tabKey(type, state);
	let pending = opening.get(workspace);
	if (!pending) {
		pending = new Map<string, Promise<void>>();
		opening.set(workspace, pending);
	}
	const underway = pending.get(key);
	if (underway) return underway;

	const open = async () => {
		// getViewState also describes restored tabs whose view is still deferred.
		const existing = workspace.getLeavesOfType(type).find(leaf =>
			tabKey(type, leaf.getViewState().state ?? {}) === key);
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({type, state: {...state}, active: true});
		await workspace.revealLeaf(leaf);
	};
	const promise = open().finally(() => pending.delete(key));
	pending.set(key, promise);
	return promise;
}
