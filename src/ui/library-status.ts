import { gitDisabled } from './device.ts';
import type KnowledgeBaseManager from '../main.ts';
import { discover } from '../kb/catalog.ts';
import { guardGit } from '../git/guard.ts';
import { previewVersion } from '../git/versions.ts';

export function attachLibraryStatus(plugin:KnowledgeBaseManager){
	const item=plugin.addStatusBarItem();
	item.hide();
	let request=0, active='', timer=0;
	const refresh=()=>{
		const generation=++request;
		window.clearTimeout(timer);
		const note=plugin.app.workspace.getActiveFile()?.path;
		if(gitDisabled(plugin) || !note){active='';item.hide();return;}
		timer=window.setTimeout(()=>{void update(note,generation).catch(()=>{if(generation===request)item.hide();});},250);
	};
	async function update(note:string,generation:number){
		const lib=(await discover(plugin.disk,plugin.config)).find(l=>l.identity && !l.problem && !l.duplicate && note.startsWith(l.location+'/'));
		if(generation!==request)return;
		active=lib?.location??'';
		const prefs=plugin.preferences(lib?.identity?.id);
		if(!lib?.identity || lib.git!=='local' || lib.problem || lib.duplicate || !prefs.showStatusBar){item.hide();return;}
		const dir=await plugin.disk.path(lib.location);
		const preview=prefs.changedFilesInStatusBar ? await previewVersion(dir) : undefined;
		const branch=prefs.showBranchStatusBar ? preview?.branch ?? await guardGit(dir,new Set(),true) : '';
		if(generation!==request)return;
		item.setText([lib.identity.displayName,branch,preview ? '± '+preview.changes.length : ''].filter(Boolean).join(' · '));
		item.setAttribute('aria-label',lib.location);
		item.show();
	}
	plugin.registerEvent(plugin.app.workspace.on('file-open',refresh));
	plugin.registerEvent(plugin.app.vault.on('modify',f=>{if(active && f.path.startsWith(active+'/'))refresh();}));
	plugin.register(()=>{request++;window.clearTimeout(timer);});
	plugin.app.workspace.onLayoutReady(refresh);
	return refresh;
}
