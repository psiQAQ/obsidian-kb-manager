import { gitDisabled } from './device.ts';
import { watchLibraryChanges } from './refresh.ts';
import { cloneWizard } from './clone.ts';
import { ItemView, Menu, Notice, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { discover } from '../kb/catalog.ts';
import { adopt, legacyBinding, adoptionWarnings } from '../kb/create.ts';
import { resolveDuplicate } from './identity.ts';
import { createWizard } from './create.ts';
import { edit,health,move,resumeMove } from './maintain.ts';
import { sourcePanel } from './source.ts';
import { networkPanel } from './network.ts';
import { librarySettings } from '../settings.ts';
import { tr } from '../i18n.ts';
import { Dialog } from './dialog.ts';
import { manageRegistry, relocateRegistryEntry, removeRegistryEntry, showImportPreview } from './manager-registry.ts';

export const managerType='knowledge-base-manager-view';
export class ManagerView extends ItemView {
	readonly plugin: KnowledgeBaseManager;
	private expanded?: string;
	private readonly drafts = new Map<string,string>();
	private rendering?: AbortController;
	private networkReady?: Promise<void>;
	private networkActions=new Map<string,()=>Promise<void>>();
	async runNetworkAction(id:string,action:string){
		await this.showLibrary(id);
		await this.networkReady;
		const run=this.networkActions.get(action);
		if(this.expanded!==id || !run)throw new Error(tr('此库当前无法执行该操作','This action is unavailable for the selected library'));
		await run();
	}
	async showLibrary(id: string){
		this.expanded=id;
		await this.render();
	}
	async onClose(){
		this.rendering?.abort();
		this.contentEl.empty();
		await super.onClose();
	}
	constructor(leaf: WorkspaceLeaf,plugin: KnowledgeBaseManager) {super(leaf); this.plugin=plugin;}
	getViewType(){return managerType;}
	getDisplayText(){return tr('知识库管理器',"Knowledge base manager");}
	getIcon(){return 'library';}
	async onOpen(){await this.render();}
	async render(){
		this.rendering?.abort();
		this.networkActions.clear();
		this.networkReady=undefined;
		this.rendering=new AbortController();
		const signal=this.rendering.signal;
		const el=this.contentEl;
		el.addClass('kb-manager-sidebar');
		el.empty();
		new Setting(el).setName(tr('知识库',"Knowledge bases")).setHeading()
			.addButton(b=>b.setButtonText(tr('新建',"New")).onClick(()=>this.create()))
			.addExtraButton(b=>b.setIcon('download').setTooltip(tr('克隆知识库','Clone library')).onClick(()=>cloneWizard(this.plugin)))
			.addButton(b=>b.setButtonText(tr('登记','Registry')).onClick(()=>manageRegistry(this.plugin)))
			.addButton(b=>b.setButtonText(tr('刷新',"Refresh")).onClick(()=>this.render()));
		try {
			for(const record of Object.values(this.plugin.moves)){
				const row=new Setting(el).setName(record.source+' → '+record.destination).setDesc(tr('移动阶段：',"Move phase: ")+record.phase);
				if(record.phase!=='complete')row.addButton(b=>b.setButtonText(tr('复核并继续',"Review and continue")).onClick(async()=>{
					try{await resumeMove(this.plugin,record);}catch(error){new Notice(String(error),8000);}
				}));
			}
			const libraries=await discover(this.plugin.disk,this.plugin.config);
			if(signal.aborted)return;
			if (!libraries.length) el.createEl('p',{text:tr('尚未登记知识库。可以新建，或选择现有 kb.toml 登记。',"No libraries registered. Create a library or register an existing kb.toml.")});
			this.plugin.observeLibraries(libraries);
			for(const lib of libraries)this.row(lib,signal);
		} catch(error) { el.createEl('p',{text:String(error)}); }
	}
	row(lib: Library,signal:AbortSignal){
		if(lib.missing){
			new Setting(this.contentEl).setName(lib.location).setDesc(tr('登记路径下找不到 kb.toml','The registered path has no kb.toml'))
				.addButton(b=>b.setButtonText(tr('重新定位','Relocate')).onClick(()=>relocateRegistryEntry(this.plugin,lib.location)))
				.addButton(b=>b.setButtonText(tr('移除登记','Remove')).onClick(async()=>{
					try{await removeRegistryEntry(this.plugin,lib.location);}catch(error){new Notice(String(error));}
				}));
			return;
		}
		const detail=[lib.location,lib.identity?.template.id ?? tr('旧库',"Legacy"),({local:tr('独立 Git','Local Git'),missing:tr('未初始化 Git','Git not initialized'),special:tr('特殊 Git 布局','Special Git layout')})[lib.git], lib.identity?.archived ? tr('已归档',"Archived") : '',lib.problem,
			lib.duplicate ? tr('ID 重复，请核对两个目录',"Duplicate ID. Check both directories") : ''].filter(Boolean).join(' · ');
		const row=new Setting(this.contentEl).setName(lib.identity?.displayName ?? lib.location).setDesc(detail);
		const key=lib.identity && !lib.problem && !lib.duplicate ? lib.identity.id : 'path:'+lib.location;
		if(!gitDisabled(this.plugin))row.addExtraButton(button=>{
			button.extraSettingsEl.setAttribute('aria-expanded',String(this.expanded===key));
			button.setIcon('git-branch').setTooltip(tr('Git 状态','Git status')).onClick(()=>{
				this.expanded=this.expanded===key ? undefined : key;
				void this.render();
			});
		});
		if(this.expanded===key && (!lib.identity || lib.problem || lib.duplicate) && !gitDisabled(this.plugin)){
			const reason=lib.problem || (lib.duplicate ? tr('请先解决重复 ID','Resolve the duplicate ID first') : tr('接管此库后即可管理 Git','Adopt this library to manage Git'));
			this.contentEl.createDiv({cls:'kb-library-git',text:reason});
		}
		if(!lib.identity || lib.problem || lib.duplicate)row.addButton(b=>b.setButtonText(tr('体检',"Check library")).onClick(async()=>{try{await health(this.plugin,lib);}catch(error){new Notice(String(error));}}));
		if(lib.problem){
			row.addButton(b=>b.setButtonText(tr('移除登记','Remove')).onClick(async()=>{
				try{await removeRegistryEntry(this.plugin,lib.location);}catch(error){new Notice(String(error));}
			}));
			return;
		}
		if(lib.duplicate){
			row.addButton(b=>b.setButtonText(tr('标记为副本',"Mark as copy")).onClick(async()=>{
				try {await resolveDuplicate(this.plugin,lib);} catch(error){new Notice(String(error));}
			}));return;
		}
		if(!lib.identity) {
			row.addButton(b=>b.setButtonText(tr('预览接管',"Preview adoption")).onClick(async ()=>{
				try {
					const warnings=await adoptionWarnings(this.plugin.disk,lib);
					const dialog=new Dialog(this.app,tr('接管旧知识库',"Adopt legacy library"));
					dialog.lines([lib.location,tr('在 kb.toml 中新增 [manager]',"Add [manager] to kb.toml"),'Git · '+lib.git,...Object.entries(lib.mapping ?? {}).map(([k,v])=>k+' → '+String(v)),...warnings]);
					const candidate=await legacyBinding(this.plugin.disk,lib);
					const confirm=async(hash?:string)=>{
						await this.plugin.exclusive(lib.location,()=>adopt(this.plugin.disk,this.plugin.config,lib,warnings,hash));
						dialog.close();await this.render();
					};
					dialog.action(tr('仅添加身份',"Add identity only"),()=>confirm());
					if(candidate){
						dialog.lines([tr('可领管 knowledge.base 的库根、wiki 和 Notes 过滤条件。其他字段由原作者维护。',"The manager can maintain matching root, wiki and Notes filters in knowledge.base. Other fields remain user-managed.")]);
						dialog.action(tr('添加身份并领管已匹配的绑定',"Add identity and manage matched bindings"),()=>confirm(candidate));
					}
					dialog.open();
				} catch(error){new Notice(String(error));}
			})); return;
		}
		const id=lib.identity.id;

		row.addExtraButton(button=>button.setIcon('ellipsis').setTooltip(tr('知识库操作','Library actions')).onClick(()=>{
			const menu=new Menu();
			const action=(title:string,icon:string,run:()=>void|Promise<void>)=>menu.addItem(item=>item.setTitle(title).setIcon(icon).onClick(async()=>{
				try{await run();}catch(error){new Notice(String(error));}
			}));
			if(!gitDisabled(this.plugin))action(tr('Git 状态','Git status'),'git-branch',()=>this.showLibrary(id));
			action(tr('本库 Git 设置','Library Git settings'),'settings',()=>librarySettings(this.plugin,lib));
			action(tr('编辑','Edit'),'pencil',()=>edit(this.plugin,lib));
			if(!lib.identity?.archived)action(tr('移动','Move'),'folder-input',()=>move(this.plugin,lib));
			action(tr('体检','Check library'),'activity',()=>health(this.plugin,lib));
			action(tr('预览登记及路径绑定','Preview registration and bindings'),'map-pin',()=>showImportPreview(this.plugin,lib.location));
			action(tr('移除登记','Remove registration'),'list-x',()=>removeRegistryEntry(this.plugin,lib.location));
			const bounds=button.extraSettingsEl.getBoundingClientRect();
			menu.showAtPosition({x:bounds.left,y:bounds.bottom});
		}));
		row.addButton(b=>b.setButtonText(tr('打开',"Open")).onClick(async ()=>{
			const entry=lib.identity?.entry ?? lib.mapping?.index;
			if(!entry){
				const choices=new Dialog(this.app,lib.location);
				const files=this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith(lib.location+'/'));
				if(!files.length)choices.lines([tr('目录中没有 Markdown 文件。',"This directory has no Markdown files.")]);
				for(const file of files)choices.action(file.path.slice(lib.location.length+1),async()=>{
					await this.plugin.disk.path(file.path);await this.app.workspace.getLeaf(false).openFile(file);choices.close();
				});
				choices.open();return;
			}
			try {
				await this.plugin.disk.path(lib.location+'/'+entry);
				const file=this.app.vault.getAbstractFileByPath(lib.location+'/'+entry);
				if(file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
				else new Notice(tr('入口不存在：',"Entry not found: ")+entry);
			} catch(error){new Notice(String(error));}
		}));
		if(this.expanded===id && !gitDisabled(this.plugin)){
			const panel=this.contentEl.createDiv({cls:'kb-library-git'});
			watchLibraryChanges(this.plugin,lib,panel,signal,()=>this.render());
			const local=panel.createDiv();
			void Promise.resolve(sourcePanel(this.plugin,lib,local,this.drafts,signal)).catch(error=>{
				if(!signal.aborted)local.createEl('p',{text:String(error)});
			});
			if(!lib.identity.archived && lib.git==='local'){
				const remote=panel.createDiv();
				this.networkReady=networkPanel(this.plugin,lib,remote,(icon,action)=>{
					if(!signal.aborted)this.networkActions.set(icon,action);
				}).catch(error=>{
					if(!signal.aborted)remote.createEl('p',{text:String(error)});
				});
			}
		}

	}
	async create(){
		try{await createWizard(this.plugin,()=>this.render());}
		catch(error){new Notice(String(error),8000);}
	}
}
