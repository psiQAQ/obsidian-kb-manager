import {getLanguage,Notice,Plugin} from 'obsidian';
import {setLanguage,tr} from '../i18n.ts';
import {readPreferences} from '../preferences.ts';
import {migrateGitSettings} from '../git/settings-migration.ts';
import {verifyLibrary} from './catalog.ts';
import type {Catalog,Library} from './catalog.ts';
import {MobileSettings} from './settings.ts';
import {MobileView,viewType} from './view.ts';
import {createForm} from './forms.ts';
import {settingsPaths} from './disk.ts';

declare const KB_BUILTIN:Record<string,string>;
declare const KB_KEPANO:Record<string,string>;
type Saved=Record<string,unknown>&{parents?:string[];templates?:string[];prefs?:Record<string,unknown>};
export default class MobilePlugin extends Plugin {
	ctx!:Catalog;
	saved:Saved={};
	readonly templates={wiki:KB_BUILTIN,kepano:KB_KEPANO};
	readonly drafts=new Map<string,string>();
	private busy=new Set<string>();
	private identityKey='';
	async onload(){
		this.saved=(await this.loadData() as Saved|null)??{};
		if(migrateGitSettings(this.saved))await this.saveData(this.saved);
		this.ctx={disk:this.app.vault.adapter,configDir:this.app.vault.configDir,parents:this.saved.parents??['knowledge-base'],templates:this.saved.templates??[]};
		this.updateLanguage();
		const localKey=this.manifest.id+':mobile-identity-key';
		const existing=this.app.loadLocalStorage(localKey) as unknown;
		this.identityKey=typeof existing==='string' && /^kb-manager-[a-f0-9-]{36}-author$/u.test(existing)?existing:'kb-manager-'+crypto.randomUUID()+'-author';
		if(existing!==this.identityKey)this.app.saveLocalStorage(localKey,this.identityKey);
		this.registerView(viewType,leaf=>new MobileView(leaf,this));
		this.addSettingTab(new MobileSettings(this.app,this));
		this.addRibbonIcon('library',tr('打开知识库管理器','Open knowledge base manager'),()=>this.open());
		this.addCommand({id:'open-manager',name:tr('打开知识库管理器','Open knowledge base manager'),callback:()=>this.open()});
		this.addCommand({id:'create-library',name:tr('创建知识库','Create knowledge base'),callback:()=>createForm(this)});
	}
	updateLanguage(){const lang=readPreferences(this.saved.prefs).language;setLanguage(lang==='system'?getLanguage():lang);}
	deviceAuthor(){
		const secrets=this.app.secretStorage;
		return {name:secrets.getSecret(this.identityKey+'-name')??'',email:secrets.getSecret(this.identityKey+'-email')??''};
	}
	setDeviceAuthor(name:string,email:string){
		this.app.secretStorage.setSecret(this.identityKey+'-name',name.trim());
		this.app.secretStorage.setSecret(this.identityKey+'-email',email.trim());
	}
	async saveConfig(parents:string[],templates:string[],language:string){
		settingsPaths(parents,templates,this.ctx.configDir);
		const saved={...this.saved,parents,templates,prefs:{...this.saved.prefs,language}};
		await this.saveData(saved);
		this.saved=saved;Object.assign(this.ctx,{parents,templates});this.updateLanguage();await this.refresh();
	}
	paused(){return this.app.loadLocalStorage(this.manifest.id+':gitDisabled')===true;}
	report(e:unknown){new Notice(String(e),8000);}
	assertEnabled(){if(this.paused())throw new Error(tr('此设备已暂停知识库 Git','Library Git is paused on this device'));}
	async exclusive<T>(key:string,action:()=>Promise<T>,lib?:Library){
		this.assertEnabled();
		if(this.busy.has(key))throw new Error(tr('操作正在进行','Operation in progress'));
		this.busy.add(key);
		try{if(lib)await verifyLibrary(this.ctx,lib,true);return await action();}
		finally{this.busy.delete(key);}
	}
	store(lib:Library){return {root:lib.location,disk:this.ctx.disk,configDir:this.ctx.configDir};}
	async open(){
		try{
			const workspace=this.app.workspace,leaf=workspace.getLeavesOfType(viewType)[0]??workspace.getRightLeaf(false);
			if(!leaf)throw new Error(tr('无法打开右侧栏','Right sidebar is unavailable'));
			await leaf.setViewState({type:viewType,active:true});await workspace.revealLeaf(leaf);
		}catch(e){new Notice(String(e));}
	}
	async refresh(){
		await Promise.all(this.app.workspace.getLeavesOfType(viewType).map(leaf=>leaf.view instanceof MobileView?leaf.view.draw():Promise.resolve()));
	}
}
