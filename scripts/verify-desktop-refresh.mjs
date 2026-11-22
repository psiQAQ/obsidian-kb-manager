import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../main.js',import.meta.url),'utf8');
const require=createRequire(import.meta.url);
const scratch=resolve('.tmp');
await mkdir(scratch,{recursive:true});
const root=await mkdtemp(join(scratch,'desktop-refresh-'));
assert.equal(dirname(root),scratch);
const original='10000000-0000-4000-8000-000000000001';
const replacement='10000000-0000-4000-8000-000000000002';
const notices=[], cleanups=[], device=new Map();
let data={language:'en',defaults:{tree:false,refreshSourceControlTimer:500},registeredLibraries:['Books/First'],unknown:{keep:true}};
let sharedWrites=0;

class FileSystemAdapter { getBasePath(){return root;} }
class FileView { file={path:'Books/First/Note.md'}; }
class Plugin {
	loadData(){return structuredClone(data);}
	saveData(next){sharedWrites++;data=structuredClone(next);}
	registerView(){}
	addSettingTab(){}
	addRibbonIcon(){return {};}
	addStatusBarItem(){return {hide(){}};}
	addCommand(){}
	removeCommand(){}
	registerEditorExtension(){}
	registerEvent(off){cleanups.push(off);}
	registerInterval(){}
	register(stop){cleanups.push(stop);}
}
const obsidian={
	Platform:{isMobile:false},Plugin,FileSystemAdapter,FileView,Modal:class {},ItemView:class {},PluginSettingTab:class {update(){}},
	getLanguage:()=> 'en',setTooltip(){},Notice:class {messageEl={addClass(){}};constructor(message){notices.push(message);}},
};
function events(){
	const entries=new Map();
	return {
		on(name,callback){
			const callbacks=entries.get(name) ?? new Set();
			entries.set(name,callbacks);callbacks.add(callback);
			return ()=>callbacks.delete(callback);
		},
		emit(name,...args){for(const callback of entries.get(name) ?? [])callback(...args);},
	};
}
const owner=new EventTarget();
Object.assign(owner,{setTimeout,clearTimeout,setInterval:()=>0,document:{hasFocus:()=>true}});
const context=vm.createContext({
	module:{exports:{}},window:owner,TextEncoder,TextDecoder,URL,URLSearchParams,console,Buffer,process,
	setTimeout,clearTimeout,AbortController,
	require(id){return id==='obsidian'?obsidian:require(id);},
});
vm.runInContext(source,context,{filename:'main.js'});
const plugin=new context.module.exports();
const vault={...events(),adapter:new FileSystemAdapter(),configDir:'.qa-config'};
const historyType='knowledge-base-manager-history';
let historyRefreshes=0;
const fileView=new FileView();
fileView.containerEl={win:owner};
const recent={view:fileView,getViewState:()=>({type:'markdown'})};
const history={getViewState:()=>({type:historyType,state:{id:replacement}}),view:{
	containerEl:{win:owner},getViewType:()=>historyType,getState:()=>({id:replacement}),
	setState(){historyRefreshes++;return Promise.resolve();},
}};
const workspace={...events(),getLeavesOfType:type=>type===historyType?[history]:[],onLayoutReady(){},
	getActiveFile:()=>null,getMostRecentLeaf:()=>recent};
plugin.app={vault,workspace,loadLocalStorage:key=>device.get(key),saveLocalStorage:(key,value)=>device.set(key,structuredClone(value))};
plugin.manifest={id:'knowledge-base-manager'};
const library=join(root,'Books','First');
const manifest=join(library,'kb.toml');
const identity=(id,name)=>'version = 1\n[manager]\nschemaVersion = 1\nid = "'+id+'"\ndisplayName = "'+name+'"\ndescription = ""\narchived = false\n[manager.template]\nid = "qa"\nversion = "1"\n';
const git=(...args)=>execFileSync('git',['-C',library,...args],{stdio:'pipe'});
const eventually=async(assertion)=>{
	const until=Date.now()+5000;
	while(Date.now()<until){
		if(assertion())return;
		await delay(25);
	}
	assert.ok(assertion(),'Expected desktop refresh did not arrive · '+JSON.stringify({historyRefreshes,notices}));
};

try {
	await mkdir(library,{recursive:true});
	await writeFile(manifest,identity(original,'Original'));
	git('init','--initial-branch=main');
	await plugin.onload();
	assert.equal(plugin.known[original],'Books/First');
	assert.equal(typeof plugin.onExternalSettingsChange,'function');
	assert.equal(sharedWrites,0);
	data={...data,language:'zh',defaults:{tree:true,refreshSourceControlTimer:500},registeredLibraries:['Books/First','Books/Synced']};
	await plugin.persist();
	assert.equal(data.defaults.tree,true);
	assert.equal(sharedWrites,0);
	await plugin.onExternalSettingsChange();
	assert.equal(plugin.preferences().tree,true);
	assert.equal(plugin.prefs.language,'zh');
	assert.equal(plugin.catalog.find(lib=>lib.location==='Books/Synced').missing,true);
	assert.deepEqual(data.unknown,{keep:true});
	await writeFile(manifest,identity(replacement,'Replacement')+'\n[preferences]\nshowFileMenu = false\n');
	vault.emit('modify',{path:'Books/First/kb.toml'});
	await eventually(()=>plugin.known[replacement]==='Books/First');
	assert.equal(plugin.known[original],undefined);
	assert.equal(plugin.preferences(replacement).showFileMenu,false);
	assert.equal(plugin.catalog[0].identity.displayName,'Replacement');

	owner.dispatchEvent(new Event('focus'));
	await eventually(()=>historyRefreshes>=3);
	const baseline=historyRefreshes;
	owner.dispatchEvent(new Event('focus'));
	await delay(650);
	assert.equal(historyRefreshes,baseline);
	await writeFile(join(library,'Note.md'),'new content\n');
	git('add','Note.md');
	owner.dispatchEvent(new Event('focus'));
	await eventually(()=>historyRefreshes===baseline+1);
	git('-c','user.name=QA','-c','user.email=qa@example.invalid','commit','-m','outside Obsidian');
	owner.dispatchEvent(new Event('focus'));
	await eventually(()=>historyRefreshes===baseline+2);
	owner.dispatchEvent(new Event('focus'));
	for(const cleanup of cleanups.splice(0).reverse())cleanup();
	await delay(650);
	assert.equal(historyRefreshes,baseline+2);
	assert.deepEqual(notices,[]);
	process.stdout.write('Desktop production callback reloaded preferences and the registry, revalidated kb.toml, and detected external Git index and HEAD changes.\n');
} finally {
	for(const cleanup of cleanups.reverse())cleanup();
	await rm(root,{recursive:true,force:true});
}
