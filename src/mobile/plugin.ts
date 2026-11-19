import {getLanguage,Notice,Plugin} from 'obsidian';
import {setLanguage,tr} from '../i18n.ts';
import {effectivePreferences,readPreferences} from '../preferences.ts';
import {verifyLibrary} from './catalog.ts';
import type {Catalog,Library} from './catalog.ts';
import {MobileSettings} from './settings.ts';
import {MobileView,viewType} from './view.ts';
import {createForm} from './forms.ts';
import {registerMobileTemplates} from './insert-template.ts';
import {manifestForm,scanForm} from './registration-forms.ts';
import {settingsPaths} from './disk.ts';
import type {BindingPreview} from './bindings.ts';
import {readMobileStorage} from './storage.ts';
import type {Device,Saved} from './storage.ts';

declare const KB_BUILTIN:Record<string,string>;
declare const KB_KEPANO:Record<string,string>;
export default class MobilePlugin extends Plugin {
	ctx!:Catalog;
	saved:Saved={language:'system',defaults:{}};
	private device!:Device;
	readonly templates={wiki:KB_BUILTIN,kepano:KB_KEPANO};
	readonly drafts=new Map<string,string>();
	private busy=new Set<string>();
	private identityKey='';
	async onload(){
		const old:unknown=await this.loadData(),key=this.manifest.id+':device-v3',local:unknown=this.app.loadLocalStorage(key);
		const {saved,device}=readMobileStorage(old,local);
		this.saved=saved;this.device=device;
		this.ctx={disk:this.app.vault.adapter,configDir:this.app.vault.configDir,parents:device.parents,templates:device.templates};
		if((old || local) && JSON.stringify(local)!==JSON.stringify(device))this.persistDevice(device);
		if(old && JSON.stringify(old)!==JSON.stringify(saved))await this.saveData(saved);
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
		registerMobileTemplates(this);
		this.addCommand({id:'register-library',name:tr('登记知识库清单','Register a library manifest'),callback:()=>manifestForm(this)});
		this.addCommand({id:'scan-library-registry',name:tr('扫描目录并登记知识库','Scan a folder and register knowledge bases'),callback:()=>scanForm(this)});
	}
	updateLanguage(){const lang=this.saved.language;setLanguage(lang==='system'?getLanguage():lang);}
	preferences(lib?:Library){
		const id=lib?.identity?.id;
		return effectivePreferences({...this.saved,libraries:id && lib.preferences?{[id]:lib.preferences}:{}},id);
	}
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
		const saved={...this.saved,language:readPreferences({language}).language};
		this.persistDevice({...this.device,parents,templates});
		Object.assign(this.ctx,{parents,templates});
		await this.saveData(saved);
		this.saved=saved;this.updateLanguage();await this.refresh();
	}
	private persistDevice(device:Device){
		const key=this.manifest.id+':device-v3';
		this.app.saveLocalStorage(key,device);
		if(JSON.stringify(this.app.loadLocalStorage(key))!==JSON.stringify(device))throw new Error(tr('无法验证本设备设置已保存','Could not verify that device settings were saved'));
		this.device=device;
	}
	bindingRecovery(location:string){return this.device.bindingRepairs?.[location];}
	saveBindingRecovery(location:string,preview?:BindingPreview){
		const bindingRepairs={...this.device.bindingRepairs};
		if(preview)bindingRepairs[location]=preview;else delete bindingRepairs[location];
		this.persistDevice({...this.device,bindingRepairs});
	}
	paused(){return this.app.loadLocalStorage(this.manifest.id+':gitDisabled')===true;}
	report(e:unknown){new Notice(String(e),8000).messageEl.addClass('kb-notice-text');}
	assertEnabled(){if(this.paused())throw new Error(tr('此设备已暂停知识库 Git','Library Git is paused on this device'));}
	async exclusive<T>(key:string,action:()=>Promise<T>,lib?:Library){
		this.assertEnabled();
		if(this.busy.has(key) || this.busy.has(':catalog'))throw new Error(tr('操作正在进行','Operation in progress'));
		if(lib && this.bindingRecovery(lib.location))throw new Error(tr('请先恢复绑定更新','Resume the pending binding changes first'));
		this.busy.add(key);
		try{if(lib)await verifyLibrary(this.ctx,lib,true);return await action();}
		finally{this.busy.delete(key);}
	}
	async catalogWrite<T>(action:()=>Promise<T>){
		const key=':catalog';
		if(this.busy.size)throw new Error(tr('另一项知识库操作正在进行','Another library operation is in progress'));
		this.busy.add(key);
		try{return await action();}finally{this.busy.delete(key);}
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
