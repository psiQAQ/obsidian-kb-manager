import { gitDisabled } from './ui/device.ts';
import { registerAuthorship,refreshAuthorship } from './ui/authorship.ts';
import { registerLibraryCommands } from './ui/library-commands.ts';
import { registerFileCommands } from './ui/file-commands.ts';
import { registerLibraryTemplates } from './ui/insert-template.ts';
import { registerSourceEditor, refreshSourceEditors } from './ui/source-editor.ts';
import { attachLibraryStatus } from './ui/library-status.ts';
import { readGrants } from './git/network-automation.ts';
import { registerSourceDiff, refreshSourceTabs } from './ui/source-diff.ts';
import { migrateGitSettings } from './git/settings-migration.ts';
import { effectivePreferences, readPreferences } from './preferences.ts';
import { setLanguage, tr } from './i18n.ts';
import { startAutomation } from './ui/network.ts';
import type { AutomationGrant } from './git/network.ts';
import { deviceGitPath } from './ui/git-path.ts';
import { blameLine, configureGitExecutable } from './git/network-native.ts';
import { FileSystemAdapter, Notice, Plugin, TFolder, TFile, getLanguage, setTooltip } from 'obsidian';
import { VaultDisk } from './fs/vault.ts';
import { defaults, discover, recheck } from './kb/catalog.ts';
import type { Config } from './kb/catalog.ts';
import { isKepano } from './kb/template.ts';
import type { Library } from './kb/catalog.ts';
import type { SaveRecord } from './git/versions.ts';
import type { MoveRecord } from './kb/move.ts';
import { activeVersion } from './ui/versions.ts';
import { ManagerSettings } from './settings.ts';
import { ManagerView, managerType } from './ui/manager.ts';

declare const KB_BUILTIN: Record<string,string>;
declare const KB_KEPANO: Record<string,string>;

export default class KnowledgeBaseManager extends Plugin {
	disk!: VaultDisk;
	config!: Config;
	readonly skeleton=KB_BUILTIN;
	readonly kepanoSkeleton=KB_KEPANO;
	templateAssets(lib:Library){return isKepano(lib.identity?.template)?this.kepanoSkeleton:this.skeleton;}
	readonly t = tr;
	prefs = readPreferences(undefined);
	grants: Record<string,AutomationGrant> = {};
	preferences(id?:string){return effectivePreferences(this.prefs,id);}
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
		this.moves[record.id]=record;
		await this.persist();
	}
	private pendingSave = Promise.resolve();
	persist() {
		const save = this.pendingSave.then(()=>this.saveData({...this.config,known:this.known,moves:this.moves,saves:this.saves,prefs:this.prefs,grants:this.grants}));
		this.pendingSave=save.catch(()=>undefined);
		return save;
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
		try { configureGitExecutable(deviceGitPath(this)); }
		catch (error) { configureGitExecutable(''); new Notice(String(error)); }
		const adapter=this.app.vault.adapter;
		if(!(adapter instanceof FileSystemAdapter))throw new Error('Desktop filesystem vault required');
		this.disk=new VaultDisk(adapter.getBasePath(),this.app.vault.configDir);
		const saved=await this.loadData() as Partial<Config> & {prefs?:unknown; grants?:Record<string,AutomationGrant>; known?: Record<string,string>; moves?:Record<string,MoveRecord>; saves?:Record<string,SaveRecord>} | null;
		if(migrateGitSettings(saved))await this.saveData(saved);
		this.config={parents:saved?.parents ?? [...defaults.parents],templates:saved?.templates ?? []};
		this.prefs=readPreferences(saved?.prefs);
		this.grants=readGrants(saved?.grants);
		this.known=saved?.known ?? {};
		this.moves=saved?.moves ?? {};
		this.saves=saved?.saves ?? {};
		this.registerView(managerType,leaf=>new ManagerView(leaf,this));
		registerSourceDiff(this);
		this.addSettingTab(new ManagerSettings(this));
		this.updateLanguage();
		this.ribbon=this.addRibbonIcon('library',tr('打开知识库管理器','Open knowledge base manager'),()=>this.openManager());
		registerSourceEditor(this);
		registerAuthorship(this);
		this.refreshStatus=attachLibraryStatus(this);
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
			if(file instanceof TFolder && this.config.parents.some(p=>file.parent?.path===p)){
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
		if(!(right.view instanceof ManagerView))throw new Error('Manager unavailable');
		for(const item of old)if(item!==right)item.detach();
		return right.view;
	}
	async refresh(){
		this.updateLanguage();
		await refreshSourceTabs(this);
		refreshAuthorship(this);
		refreshSourceEditors(this);
		this.refreshStatus?.();
		for(const leaf of this.app.workspace.getLeavesOfType(managerType))if(leaf.view instanceof ManagerView)await leaf.view.render();
	}
}
