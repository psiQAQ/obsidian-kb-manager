import type { Workspace } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { isHistorySide } from '../git/index-history.ts';
import type { HistorySide } from '../git/index-history.ts';

export interface HistoryFileComparison {before:HistorySide;after:HistorySide;oldFile?:string}

export function isHistoryComparison(value:unknown):value is HistoryFileComparison {
	return !!value && typeof value==='object' && 'before' in value && isHistorySide(value.before)
		&& 'after' in value && isHistorySide(value.after) && (!('oldFile' in value) || typeof value.oldFile==='string');
}

export interface SourceTabState {
	id: string;
	file?: string;
	staged?: boolean;
	commit?: string;
	parent?: string;
	comparison?: HistoryFileComparison;
}

export function sourceTabKey(type: string, state: Partial<SourceTabState>) {
	const pair=isHistoryComparison(state.comparison)?state.comparison:undefined;
	const revision=(side:HistorySide)=>side.kind==='commit'?[side.kind,side.oid]:[side.kind];
	return JSON.stringify([type,state.id,state.file,pair?[revision(pair.before),revision(pair.after),pair.oldFile??state.file]:state.commit??state.staged,state.parent]);
}

const opening = new WeakMap<Workspace, Map<string, Promise<void>>>();

export function revealSourceTab(plugin: KnowledgeBaseManager, type: string, state: SourceTabState): Promise<void> {
	const {workspace} = plugin.app;
	const key = sourceTabKey(type, state);
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
			sourceTabKey(type, leaf.getViewState().state ?? {}) === key);
		const leaf = existing ?? workspace.getLeaf('tab');
		if (!existing) await leaf.setViewState({type, state: {...state}, active: true});
		await workspace.revealLeaf(leaf);
		workspace.setActiveLeaf(leaf, {focus: true});
	};
	const promise = open().finally(() => pending.delete(key));
	pending.set(key, promise);
	return promise;
}
