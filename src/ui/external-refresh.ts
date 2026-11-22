import { FileView } from 'obsidian';
import type { TAbstractFile, WorkspaceContainer } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { identityFile } from '../kb/identity-core.ts';
import { repositoryActivity } from '../git/activity.ts';
import { gitDisabled, pluginNotice } from './device.ts';
import { ManagerView, managerType } from './manager.ts';
import { refreshSourceTabs, sourceTabId } from './source-diff.ts';
import { refreshSourceEditors } from './source-editor.ts';
import { refreshAuthorship } from './authorship.ts';

export function watchExternalLibraryState(plugin:KnowledgeBaseManager){
	const {vault,workspace}=plugin.app;
	const owners=new Map<Window,()=>void>();
	const changed=new Set<string>();
	let manifestTimer:number|undefined,disposed=false;
	const managers=(owner?:Window)=>workspace.getLeavesOfType(managerType)
		.map(leaf=>leaf.view)
		.filter((view):view is ManagerView=>view instanceof ManagerView && (!owner || view.contentEl.win===owner));
	const report=(error:unknown)=>{if(!disposed)pluginNotice(plugin,'error',String(error));};
	const updateEditors=(locations:ReadonlySet<string>)=>{
		const roots=[...locations].map(location=>location+'/');
		const includes=(file:string)=>roots.some(root=>file.startsWith(root));
		refreshSourceEditors(plugin,includes);
		refreshAuthorship(plugin,includes);
		plugin.refreshStatusBar();
	};
	async function updateManifest(locations:ReadonlySet<string>){
		const before=new Map(plugin.catalog.map(lib=>[lib.location,lib]));
		const libraries=await plugin.refreshCatalog(locations);
		if(disposed)return;
		const after=new Map(libraries.map(lib=>[lib.location,lib]));
		const paths=new Set([...before.keys(),...after.keys()].filter(path=>before.get(path)!==after.get(path)));
		const ids=new Set<string>();
		for(const path of paths)for(const lib of [before.get(path),after.get(path)])if(lib?.identity)ids.add(lib.identity.id);
		if(!paths.size)return;
		updateEditors(paths);
		await Promise.all([
			refreshSourceTabs(plugin,ids),
			...managers().map(view=>view.refreshRows(libraries,paths)),
		]);
	}
	const manifest=(file:TAbstractFile,previous?:string)=>{
		for(const {location} of plugin.catalog){
			const target=location+'/'+identityFile;
			if([file.path,previous].some(path=>path && (path===target || target.startsWith(path+'/'))))changed.add(location);
		}
		if(!changed.size)return;
		window.clearTimeout(manifestTimer);
		manifestTimer=window.setTimeout(()=>{
			const paths=new Set(changed);
			changed.clear();
			void updateManifest(paths).catch(report);
		},120);
	};
	for(const event of [vault.on('create',manifest),vault.on('modify',manifest),vault.on('delete',manifest),vault.on('rename',manifest)])
		plugin.registerEvent(event);

	function watch(owner:Window,container?:WorkspaceContainer){
		if(disposed || owners.has(owner))return;
		const signatures=new Map<string,string>();
		const timers=new Map<string,number>();
		let closed=false;
		const current=()=>{
			const ids=new Set<string>();
			const recent=workspace.getMostRecentLeaf(container ?? workspace.rootSplit);
			if(recent?.view.containerEl.win===owner){
				const view=recent.view;
				const file=view instanceof FileView?view.file?.path:undefined;
				const id=sourceTabId(recent) ?? (file?Object.entries(plugin.known).find(([,root])=>file.startsWith(root+'/'))?.[0]:undefined);
				if(id)ids.add(id);
			}
			for(const view of managers(owner))if(view.contentEl.isShown()){
				const id=view.selectedLibrary?.identity?.id;
				if(id)ids.add(id);
			}
			return new Map(plugin.catalog.flatMap(lib=>{
				const id=lib.identity?.id;
				return id && ids.has(id) && !lib.problem && !lib.duplicate && lib.git==='local' && plugin.preferences(id).refreshSourceControl
					?[[id,lib] as const]:[];
			}));
		};
		async function verify(id:string,expected:Library){
			const active=()=>!closed && owner.document.hasFocus() && !gitDisabled(plugin) && current().get(id)?.location===expected.location;
			if(!active())return;
			const signature=expected.location+'\0'+await repositoryActivity(await plugin.disk.path(expected.location));
			if(!active() || signature===signatures.get(id))return;
			signatures.set(id,signature);
			const paths=new Set([expected.location]);
			updateEditors(paths);
			await Promise.all([
				refreshSourceTabs(plugin,new Set([id]),owner),
				...managers(owner).filter(view=>view.selectedLibrary?.location===expected.location)
					.map(view=>view.refreshRows(plugin.catalog,paths)),
			]);
		}
		const cancel=()=>{for(const timer of timers.values())owner.clearTimeout(timer);timers.clear();};
		const focus=()=>{
			cancel();
			if(gitDisabled(plugin))return;
			for(const [id,lib] of current()){
				timers.set(id,owner.setTimeout(()=>{
					timers.delete(id);
					void verify(id,lib).catch(error=>{if(!closed)report(error);});
				},plugin.preferences(id).refreshSourceControlTimer));
			}
		};
		owner.addEventListener('focus',focus);
		owner.addEventListener('blur',cancel);
		owners.set(owner,()=>{
			closed=true;cancel();
			owner.removeEventListener('focus',focus);
			owner.removeEventListener('blur',cancel);
		});
	}
	plugin.registerEvent(workspace.on('window-open',(container,owner)=>watch(owner,container)));
	plugin.registerEvent(workspace.on('window-close',(_container,owner)=>{owners.get(owner)?.();owners.delete(owner);}));
	watch(window);
	workspace.onLayoutReady(()=>workspace.iterateAllLeaves(leaf=>{
		const owner=leaf.view.containerEl.win;
		if(owner!==window)watch(owner,leaf.getContainer());
	}));
	plugin.register(()=>{
		disposed=true;window.clearTimeout(manifestTimer);
		for(const stop of owners.values())stop();
		owners.clear();
	});
}
