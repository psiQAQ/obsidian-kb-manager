import { gitDisabled } from './ui/device.ts';
import { registerAuthorship,refreshAuthorship } from './ui/authorship.ts';
import { registerLibraryCommands } from './ui/library-commands.ts';
import { registerFileCommands } from './ui/file-commands.ts';
import { registerLibraryTemplates } from './ui/insert-template.ts';
import { registerSourceEditor, refreshSourceEditors } from './ui/source-editor.ts';
import { attachLibraryStatus } from './ui/library-status.ts';
import { readGrants } from './git/network-automation.ts';
import { registerSourceDiff, refreshSourceTabs } from './ui/source-diff.ts';
import { effectivePreferences, readPendingLibraryPreferences, readPreferences } from './preferences.ts';
import type { GitPreferences, Language, PreferenceStore } from './preferences.ts';
import { identityFile, readManifest, writePreferences } from './kb/identity-core.ts';
import { readManifestFile, replaceLibraryManifest } from './kb/manifest-disk.ts';
import { previewPreferenceMigration } from './kb/preference-migration.ts';
import { setLanguage, tr } from './i18n.ts';
import { startAutomation } from './ui/network.ts';
import type { AutomationGrant } from './git/network.ts';
import { deviceGitPath } from './ui/git-path.ts';
import { blameLine, configureGitExecutable } from './git/network-native.ts';
import { FileSystemAdapter, Notice, Plugin, TFolder, TFile, getLanguage, setTooltip } from 'obsidian';
import { VaultDisk, digest } from './fs/vault.ts';
import { defaults, discover, recheck } from './kb/catalog.ts';
import type { Config } from './kb/catalog.ts';
import { isKepano } from './kb/template.ts';
import type { Library } from './kb/catalog.ts';
import type { SaveRecord } from './git/versions.ts';
import type { MoveRecord } from './kb/move.ts';
import { activeVersion } from './ui/versions.ts';
import { ManagerSettings } from './settings.ts';
import { ManagerView, managerType } from './ui/manager.ts';
import { watchExternalLibraryState } from './ui/external-refresh.ts';

import {packText} from './kb/template-pack.ts';

export default class KnowledgeBaseManager extends Plugin {
	disk!: VaultDisk;
	config!: Config;
	readonly skeleton=packText('llm-wiki');
	readonly kepanoSkeleton=packText('kepano');
	templateAssets(lib:Library){return isKepano(lib.identity?.template)?this.kepanoSkeleton:this.skeleton;}
	readonly t = tr;
	prefs = readPreferences(undefined);
	pendingLibraryPreferences:PreferenceStore['libraries']={};
	grants: Record<string,AutomationGrant> = {};
	private registeredLocations = new Set<string>();
	private missingIds=new Map<string,string>();
	private libraries:Library[]=[];
	private pendingCatalog:Promise<unknown>=Promise.resolve();
	private disposed=false;
	private settingTab?:ManagerSettings;
	preferences(id?:string){return effectivePreferences(this.prefs,id);}
	get catalog():readonly Library[]{return this.libraries;}
	private observeLibraries(libraries:Library[]) {
		for(const lib of libraries){
			if(!lib.missing){this.missingIds.delete(lib.location);continue;}
			const previous=this.libraries.find(item=>item.location===lib.location && !item.problem && !item.duplicate)?.identity;
			if(previous)this.missingIds.set(lib.location,previous.id);
		}
		this.libraries=libraries;
		const overrides:typeof this.prefs.libraries={};
		this.registeredLocations=new Set(libraries.map(lib=>lib.location));
		for(const location of this.missingIds.keys())if(!this.registeredLocations.has(location))this.missingIds.delete(location);
		this.known={};
		for(const lib of libraries)if(lib.identity && !lib.duplicate && !lib.problem){
			this.known[lib.identity.id]=lib.location;
			overrides[lib.identity.id]=lib.preferences ?? {};
		}
		this.prefs.libraries=overrides;
	}
	previousLibraryId(location:string){return this.missingIds.get(location);}
	async saveLibraryPreferences(lib:Library, overrides:Partial<GitPreferences>) {
		await this.exclusive(lib.location,()=>this.writeLibraryPreferences(lib,overrides));
	}
	private async writeLibraryPreferences(lib:Library, overrides:Partial<GitPreferences>) {
		const current=await recheck(this.disk,this.config,lib);
		if(!current.identity || current.identity.archived)throw new Error(tr('此库只读','Library is read-only'));
		const relative=lib.location+'/'+identityFile;
		const initial=await readManifestFile(await this.disk.path(relative));
		if(initial.signature!==current.signature)throw new Error(tr('清单已变更，请重新打开设置','Manifest changed. Reopen settings.'));
		const raw=writePreferences(initial.raw,overrides);
		await replaceLibraryManifest(this.disk,lib.location,initial.signature,raw);
		const verified=await readManifestFile(await this.disk.path(relative));
		if(verified.signature!==digest(raw))throw new Error(tr('未能核验已保存的清单','Could not verify the saved manifest'));
		lib.signature=verified.signature;
		lib.preferences=readManifest(verified.raw).preferences;
		this.prefs.libraries[current.identity.id]=lib.preferences;
	}
	async previewPendingPreferences(id:string) {
		return previewPreferenceMigration(await discover(this.disk,this.config),id,this.pendingLibraryPreferences[id]);
	}
	async applyPendingPreferences(id:string, preview:ReturnType<typeof previewPreferenceMigration>) {
		await this.exclusive(preview.target.location,async()=>{
			const fresh=await this.previewPendingPreferences(id);
			if(JSON.stringify(fresh)!==JSON.stringify(preview))
				throw new Error(tr('迁移预览已变化，请重新预览','The migration preview changed. Preview again'));
			await this.writeLibraryPreferences(fresh.target,fresh.overrides);
			delete this.pendingLibraryPreferences[id];
			try {await this.persist();}
			catch(error){this.pendingLibraryPreferences[id]=fresh.previous;throw error;}
		});
	}
	private refreshStatus?:()=>void;
	private language = '';
	private ribbon?: HTMLElement;
	private opening?: Promise<ManagerView>;
	known: Record<string,string> = {};
	moves: Record<string, MoveRecord> = {};
	saves: Record<string,SaveRecord> = {};
	async recordMove(record:MoveRecord) {
		if(Object.values(this.moves).some(r=>r.phase!=='complete' && r.token!==record.token &&
			[r.source,r.destination].some(p=>p===record.source || p===record.destination)))throw new Error(tr('此路径有待恢复的移动',"This path has a move awaiting recovery"));
		if(record.phase==='complete')delete this.moves[record.id];
		else this.moves[record.id]=record;
		await this.persist();
	}
	private pendingSave = Promise.resolve();
	persist() {
		const save = this.pendingSave.then(async()=>{
			for(const [id,receipt] of Object.entries(this.saves))if(receipt.committed && !receipt.problem)delete this.saves[id];
			const key=this.manifest.id+':device-v3';
			const local=this.app.loadLocalStorage(key) as Record<string,unknown>|null;
			const pendingLibraryPreferences=this.pendingLibraryPreferences;
			this.app.saveLocalStorage(key,{...local,...this.config,grants:this.grants,moves:this.moves,saves:this.saves,pendingLibraryPreferences});
			const stored=this.app.loadLocalStorage(key) as Record<string,unknown>|null;
			if(JSON.stringify(readPendingLibraryPreferences(stored?.pendingLibraryPreferences,undefined))!==JSON.stringify(pendingLibraryPreferences))
				throw new Error(tr('无法核验本设备暂存的旧版每库设置','Could not verify the legacy library preferences saved on this device'));
		});
		this.pendingSave=save.catch(()=>undefined);
		return save;
	}
	saveSharedPreferences(patch:{language?:Language;defaults?:Partial<GitPreferences>;remove?:readonly (keyof GitPreferences)[]}){
		return this.updateCatalog(async()=>{
			const prefs=await this.disk.registry.savePreferences(patch);
			Object.assign(this.prefs,{language:prefs.language,defaults:prefs.defaults});
		});
	}
	private updateCatalog<T>(action:()=>Promise<T>){
		const update=this.pendingCatalog.then(action);
		this.pendingCatalog=update.catch(()=>undefined);
		return update;
	}
	refreshCatalog(changed?:ReadonlySet<string>, reloadShared=false){
		return this.updateCatalog(async()=>{
			if(this.disposed)return this.libraries;
			const shared=reloadShared?await this.disk.registry.readSettings():undefined;
			const libraries=await discover(this.disk,this.config,shared?.paths,
				changed?{libraries:this.libraries,changed}:undefined);
			if(this.disposed)return this.libraries;
			if(shared)Object.assign(this.prefs,{language:shared.prefs.language,defaults:shared.prefs.defaults});
			this.observeLibraries(libraries);
			return libraries;
		});
	}
	override async onExternalSettingsChange(){
		if(this.disposed || !this.disk)return;
		try {
			const libraries=await this.refreshCatalog(undefined,true);
			if(this.disposed)return;
			this.settingTab?.update();
			await this.refreshViews(libraries);
		} catch(error) { if(!this.disposed)new Notice(String(error)); }
	}
	async exclusiveGit<T>(location:string, action:()=>Promise<T>){
		if(gitDisabled(this))throw new Error(tr('本设备已停用 Git','Git is disabled on this device'));
		return this.exclusive(location,action);
	}
	private busy = new Set<string>();
	async exclusive<T>(location: string, action: ()=>Promise<T>, recovering=false): Promise<T> {
		if(!recovering && Object.values(this.moves).some(r=>r.phase!=='complete' && [r.source,r.destination].includes(location)))throw new Error(tr('请先恢复待完成的目录移动',"Resume the pending move first"));
		if(this.busy.has(location))throw new Error(tr('此知识库正在执行另一项操作',"Another operation is running for this library"));
		this.busy.add(location);
		try{return await action();}finally{this.busy.delete(location);}
	}
	async onload(){
		const adapter=this.app.vault.adapter;
		if(!(adapter instanceof FileSystemAdapter))throw new Error('Desktop filesystem vault required');
		this.disk=new VaultDisk(adapter.getBasePath(),this.app.vault.configDir,{load:()=>this.loadData(),save:data=>this.saveData(data)});
		try { configureGitExecutable(deviceGitPath(this),this.disk.root); }
		catch (error) { configureGitExecutable('',this.disk.root); new Notice(String(error)); }
		const saved=await this.loadData() as Partial<Config> & {prefs?:unknown; grants?:Record<string,AutomationGrant>; known?: Record<string,string>; moves?:Record<string,MoveRecord>; saves?:Record<string,SaveRecord>} | null;
		const device=this.app.loadLocalStorage(this.manifest.id+':device-v3') as (NonNullable<typeof saved> & {pendingLibraryPreferences?:unknown})|null;
		const state=device ?? saved;
		this.config={parents:state?.parents ?? [...defaults.parents],templates:state?.templates ?? []};
		this.pendingLibraryPreferences=readPendingLibraryPreferences(device?.pendingLibraryPreferences,saved);
		this.grants=readGrants(state?.grants);
		if(!device)for(const grant of Object.values(this.grants))grant.paused='review';
		this.moves=Object.fromEntries(Object.entries(state?.moves ?? {}).filter(([,record])=>record.phase!=='complete'));
		this.saves=state?.saves ?? {};
		await this.persist();
		this.prefs=await this.disk.registry.migratePreferences(saved);
		try{await this.refreshCatalog();}catch(error){new Notice(String(error));}
		this.registerView(managerType,leaf=>new ManagerView(leaf,this));
		registerSourceDiff(this);
		this.updateLanguage();
		this.settingTab=new ManagerSettings(this);
		this.addSettingTab(this.settingTab);
		this.ribbon=this.addRibbonIcon('library',tr('打开知识库管理器','Open knowledge base manager'),()=>this.openManager());
		registerSourceEditor(this);
		registerAuthorship(this);
		this.refreshStatus=attachLibraryStatus(this);
		this.register(()=>{this.disposed=true;});
		watchExternalLibraryState(this);
		startAutomation(this);
		this.app.workspace.onLayoutReady(()=>{
			if(this.app.workspace.getLeavesOfType(managerType).some(leaf=>leaf.getRoot()!==this.app.workspace.rightSplit)){
				void this.openManager().catch(error=>new Notice(String(error)));
			}
		});
		this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{
			if(!gitDisabled(this) && file instanceof TFile){
				const entry=Object.entries(this.known).find(([,root])=>file.path.startsWith(root+'/'));
				if(entry && this.preferences(entry[0]).showFileMenu)menu.addItem(item=>item.setTitle(tr('本库 Git 状态','Library Git status')).setIcon('git-branch').onClick(async()=>{
					const view=await this.openManager();
					await view.showLibrary(entry[0]);
				}));
			}
			if(file instanceof TFolder && this.registeredLocations.has(file.path)){
				menu.addItem(item=>item.setTitle(tr('打开知识库管理器',"Open knowledge base manager")).setIcon('library').onClick(()=>this.openManager()));
			}
		}));
	}
	private updateLanguage(){
		const lang=this.prefs.language==='system' ? getLanguage() : this.prefs.language;
		if(this.language===lang)return false;
		if(this.language)for(const id of ['version-save','version-history','open-manager','create-library','line-author','insert-library-template'])this.removeCommand(id);
		const reload=Boolean(this.language);
		this.language=lang;
		setLanguage(lang);
		registerFileCommands(this,reload);
		registerLibraryCommands(this,reload);
		registerLibraryTemplates(this);
		if(this.ribbon)setTooltip(this.ribbon,tr('打开知识库管理器','Open knowledge base manager'));
		for (const [mode,name] of [['save',tr('保存本库版本',"Save a library version")],['history',tr('查看本库历史',"View library history")]] as const){
			this.addCommand({id:'version-'+mode,name,callback:async()=>{
				try{if(gitDisabled(this))throw new Error(tr('本设备已停用 Git','Git is disabled on this device'));await activeVersion(this,mode);}catch(error){new Notice(String(error),8000);}
			}});
		}
		this.addCommand({id:'open-manager',name:tr('打开知识库管理器',"Open knowledge base manager"),callback:()=>this.openManager()});
		this.addCommand({id:'create-library',name:tr('新建知识库',"Create knowledge base"),callback:async()=>(await this.openManager()).create()});
		this.addCommand({id:'line-author',name:tr('查看当前行作者','Show current line author'),editorCallback:async(editor,ctx)=>{
			try {
				if(gitDisabled(this))throw new Error(tr('本设备已停用 Git','Git is disabled on this device'));
				const file=ctx.file;
				const line=editor.getCursor().line+1;
				if(!file)return;
				const lib=(await discover(this.disk,this.config)).find(l=>file.path.startsWith(l.location+'/'));
				if(!lib?.identity)throw new Error(tr('文件不在知识库中','File is outside a managed library'));
				const settings=this.preferences(lib.identity.id);
				if(!settings.lineAuthor)throw new Error(tr('请启用行作者功能','Enable line author information'));
				await recheck(this.disk,this.config,lib);
				const info=await blameLine(await this.disk.path(lib.location),file.path.slice(lib.location.length+1),line);
				new Notice(info.author+' · '+info.oid.slice(0,10)+' · '+info.summary);
			}catch(error){new Notice(String(error));}
		}});
		return true;
	}
	async openManager(): Promise<ManagerView> {
		this.opening ??= this.openRight().finally(()=>{this.opening=undefined;});
		return this.opening;
	}
	private async openRight(){
		const workspace=this.app.workspace;
		const old=workspace.getLeavesOfType(managerType);
		let right=old.find(leaf=>leaf.getRoot()===workspace.rightSplit);
		if(!right){
			right=workspace.getRightLeaf(false) ?? undefined;
			if(!right)throw new Error(tr('右侧栏不可用','Right sidebar is unavailable'));
			await right.setViewState({type:managerType});
		}
		await workspace.revealLeaf(right);
		await right.loadIfDeferred();
		if(!(right.view instanceof ManagerView) && right.getViewState().type===managerType){
			// A plugin reload can leave the old constructor attached to this library sidebar.
			const state=right.getViewState();
			await right.setViewState({type:'empty'});
			await right.setViewState(state);
			await right.loadIfDeferred();
		}
		if(!(right.view instanceof ManagerView))throw new Error('Manager unavailable');
		for(const item of old)if(item!==right)item.detach();
		return right.view;
	}
	async refresh(){
		await this.refreshViews(await this.refreshCatalog());
	}
	private async refreshViews(libraries:Library[]){
		if(this.disposed)return;
		this.updateLanguage();
		await refreshSourceTabs(this);
		refreshAuthorship(this);
		refreshSourceEditors(this);
		this.refreshStatus?.();
		for(const leaf of this.app.workspace.getLeavesOfType(managerType))if(leaf.view instanceof ManagerView)await leaf.view.render(undefined,libraries);
	}
	refreshStatusBar(){this.refreshStatus?.();}
}
