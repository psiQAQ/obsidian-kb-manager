import type KnowledgeBaseManager from '../main.ts';
import { configureGitExecutable, probeGitExecutable } from '../git/network-native.ts';

export function deviceGitPath(plugin:KnowledgeBaseManager):string {
	const path:unknown=plugin.app.loadLocalStorage(plugin.manifest.id+':gitPath');
	return typeof path==='string'?path:'';
}

export async function saveDeviceGitPath(plugin:KnowledgeBaseManager, input:string) {
	const path=input.trim();
	if(path) await probeGitExecutable(path);
	configureGitExecutable(path,plugin.disk.root);
	plugin.app.saveLocalStorage(plugin.manifest.id+':gitPath',path || null);
}
