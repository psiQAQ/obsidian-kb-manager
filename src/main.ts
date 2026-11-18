import { FileSystemAdapter, Plugin, TFolder } from 'obsidian';
import { VaultDisk } from './fs/vault.ts';
import { defaults } from './kb/catalog.ts';
import type { Config } from './kb/catalog.ts';
import { ManagerSettings } from './settings.ts';
import { ManagerView, managerType } from './ui/manager.ts';

declare const KB_BUILTIN: Record<string,string>;

export default class KnowledgeBaseManager extends Plugin {
	disk!: VaultDisk;
	config!: Config;
	readonly skeleton=KB_BUILTIN;
	known: Record<string,string> = {};
	private pendingSave = Promise.resolve();
	persist() {
		const save = this.pendingSave.then(()=>this.saveData({...this.config,known:this.known}));
		this.pendingSave=save.catch(()=>undefined);
		return save;
	}
	async onload(){
		const adapter=this.app.vault.adapter;
		if(!(adapter instanceof FileSystemAdapter))throw new Error('Desktop filesystem vault required');
		this.disk=new VaultDisk(adapter.getBasePath(),this.app.vault.configDir);
		const saved=await this.loadData() as Partial<Config> & {known?: Record<string,string>} | null;
		this.config={parents:saved?.parents ?? [...defaults.parents],templates:saved?.templates ?? [],author:saved?.author ?? '',email:saved?.email ?? ''};
		this.known=saved?.known ?? {};
		this.registerView(managerType,leaf=>new ManagerView(leaf,this));
		this.addSettingTab(new ManagerSettings(this));
		this.addRibbonIcon('library','打开知识库管理器',()=>this.openManager());
		this.addCommand({id:'open-manager',name:'打开知识库管理器',callback:()=>this.openManager()});
		this.addCommand({id:'create-library',name:'新建知识库',callback:async()=>(await this.openManager()).create()});
		this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{
			if(file instanceof TFolder && this.config.parents.some(p=>file.parent?.path===p)){
				menu.addItem(item=>item.setTitle('打开知识库管理器').setIcon('library').onClick(()=>this.openManager()));
			}
		}));
	}
	async openManager(): Promise<ManagerView> {
		const workspace=this.app.workspace;
		const leaf=workspace.getLeavesOfType(managerType)[0] ?? workspace.getLeaf('tab');
		await leaf.setViewState({type:managerType,active:true});
		await workspace.revealLeaf(leaf);
		if(!(leaf.view instanceof ManagerView))throw new Error('Manager unavailable');
		return leaf.view;
	}
	async refresh(){for(const leaf of this.app.workspace.getLeavesOfType(managerType))if(leaf.view instanceof ManagerView)await leaf.view.render();}
}
