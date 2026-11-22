import { gitDisabled } from './device.ts';
import { watchLibraryChanges } from './refresh.ts';
import { cloneWizard } from './clone.ts';
import { ItemView, Menu, Notice, Setting, TFile, Vault, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { adopt, legacyBinding, adoptionWarnings } from '../kb/create.ts';
import { resolveDuplicate } from './identity.ts';
import { createWizard } from './create.ts';
import { edit,maintainBindings,move,reviewPendingMove,upgradeManifest } from './maintain.ts';
import { sourcePanel } from './source.ts';
import { networkPanel } from './network.ts';
import { librarySettings } from '../settings.ts';
import { tr } from '../i18n.ts';
import { Dialog, V3Dialog, dialogContents } from './dialog.ts';
import { manageRegistry, relocateRegistryEntry, removeRegistryEntry, showImportPreview } from './manager-registry.ts';
import { builtinPacks } from '../kb/template-pack.ts';
import { checkLibrary } from './v3-health.ts';
import { createPanelTabs } from './panel-tabs.ts';
import { captureInputSelection } from './input-selection.ts';
import { updateTemplateFiles } from './template-update.ts';

export const managerType='knowledge-base-manager-view';
type WorkspaceTab='changes'|'remote';

export class ManagerView extends ItemView {
	readonly plugin: KnowledgeBaseManager;
	private selection?:string;
	private expanded?: string;
	private readonly drafts = new Map<string,string>();
	private readonly workspaceTabs = new Map<string,WorkspaceTab>();
	private generation=0;
	private rows=new Map<string,{host:HTMLElement; controller?:AbortController}>();
	private networkReady?: Promise<void>;
	private networkActions=new Map<string,()=>Promise<void>>();
	async runNetworkAction(id:string,action:string){
		await this.showLibrary(id,'remote');
		await this.networkReady;
		const run=this.networkActions.get(action);
		if(this.expanded!==id || !run)throw new Error(tr('此库当前无法执行该操作','This action is unavailable for the selected library'));
		await run();
	}
	async showLibrary(id: string, tab?:WorkspaceTab){
		this.selection=id;
		this.expanded=id;
		if(tab)this.workspaceTabs.set(id,tab);
		this.saveLayout();
		await this.render();
	}
	async onClose(){
		this.generation++;
		for(const row of this.rows.values())row.controller?.abort();
		this.rows.clear();
		this.contentEl.empty();
		await super.onClose();
	}
	constructor(leaf: WorkspaceLeaf,plugin: KnowledgeBaseManager) {super(leaf); this.plugin=plugin;}
	getViewType(){return managerType;}
	getDisplayText(){return tr('知识库管理器',"Knowledge base manager");}
	getIcon(){return 'library';}
	override getState(){
		return {selected:this.selection,expanded:!!this.expanded,tabs:Object.fromEntries(this.workspaceTabs)};
	}
	override async setState(state:unknown,result:ViewStateResult){
		await super.setState(state,result);
		if(!state || typeof state!=='object')return;
		const selected='selected' in state && typeof state.selected==='string' ? state.selected : undefined;
		const redraw=Boolean(this.selection || selected);
		this.selection=selected;
		this.expanded='expanded' in state && state.expanded===true?selected:undefined;
		this.workspaceTabs.clear();
		if('tabs' in state && state.tabs && typeof state.tabs==='object'){
			for(const [id,tab] of Object.entries(state.tabs as Record<string,unknown>))
				if(tab==='changes' || tab==='remote')this.workspaceTabs.set(id,tab);
		}
		if(redraw)await this.render();
	}
	private saveLayout(){void this.app.workspace.requestSaveLayout();}
	async onOpen(){await this.render();}
	get selectedLibrary(){
		const id=this.expanded;
		return id?this.plugin.catalog.find(lib=>lib.identity?.id===id && !lib.duplicate && !lib.problem):undefined;
	}
	async render(focusToggle?:string,libraries?:readonly Library[]){
		const generation=++this.generation;
		let problem='';
		if(!libraries)try{libraries=await this.plugin.loadCatalog();}catch(error){problem=String(error);}
		if(generation!==this.generation)return;
		const selectedInput=this.rememberCommitSelection(this.contentEl);
		for(const row of this.rows.values())row.controller?.abort();
		this.rows.clear();
		this.networkActions.clear();
		this.networkReady=undefined;
		const el=this.contentEl;
		el.addClass('kb-manager-sidebar');
		el.empty();
		new Setting(el).setClass('kb-manager-heading').setName(tr('知识库',"Knowledge bases")).setHeading()
			.addExtraButton(b=>b.setIcon('refresh-cw').setTooltip(tr('刷新知识库列表','Refresh library list')).onClick(async()=>{
				try{await this.plugin.refresh();}catch(error){new Notice(String(error));}
			}));
		new Setting(el).setClass('kb-controls-only').setClass('kb-manager-entry-actions')
			.addButton(b=>b.setButtonText(tr('新建',"Create")).setCta().onClick(()=>this.create()))
			.addButton(b=>b.setButtonText(tr('克隆','Clone')).setDisabled(gitDisabled(this.plugin)).onClick(()=>cloneWizard(this.plugin,el.win)))
			.addButton(b=>b.setButtonText(tr('登记已有库','Register existing library')).onClick(()=>manageRegistry(this.plugin,el.win)));
		try {
			for(const record of Object.values(this.plugin.moves)){
				if(record.phase==='complete')continue;
				new Setting(el).setName(tr('目录移动待完成','Pending library move'))
					.setDesc(record.source+' → '+record.destination)
					.addButton(b=>b.setButtonText(tr('复核并继续',"Review and continue")).onClick(()=>reviewPendingMove(this.plugin,record,el.win)));
			}
			if(problem)throw new Error(problem);
			if (!libraries?.length) el.createEl('p',{cls:'kb-manager-empty',text:tr('尚未登记知识库。新建可从模板开始，克隆需要 Git 远端地址。登记已有库可选择 kb.toml 或扫描目录。',
				'No libraries are registered. Create from a template, clone from a Git remote, or register existing libraries by selecting kb.toml or scanning a folder.')});
			for(const lib of libraries ?? []){
				this.rows.set(lib.location,{host:el.createDiv({cls:'kb-library-row'})});
				this.drawRow(lib,focusToggle,selectedInput);
			}
		} catch(error) { el.createEl('p',{cls:'kb-git-error',text:String(error)}); }
	}
	async refreshRows(libraries:readonly Library[],changed:ReadonlySet<string>){
		if(libraries.length!==this.rows.size || libraries.some(lib=>!this.rows.has(lib.location))){
			await this.render(undefined,libraries);return;
		}
		for(const lib of libraries)if(changed.has(lib.location))this.drawRow(lib);
	}
	private rememberCommitSelection(host:HTMLElement){
		const selection=captureInputSelection(host.querySelector<HTMLTextAreaElement>('.kb-workspace-commit textarea'));
		const id=host.querySelector<HTMLElement>('[data-kb-library-id]')?.dataset.kbLibraryId;
		if(selection && id)this.drafts.set(id,selection.value);
		return selection && id ? {id,...selection} : undefined;
	}
	private drawRow(lib:Library,focusToggle?:string,previousInput?:ReturnType<ManagerView['rememberCommitSelection']>){
		const row=this.rows.get(lib.location)!;
		const selection=previousInput ?? this.rememberCommitSelection(row.host);
		row.controller?.abort();
		const controller=row.controller=new AbortController();
		row.host.empty();
		this.row(lib,row.host,controller.signal,focusToggle,selection);
	}
	private row(lib: Library,host:HTMLElement,signal:AbortSignal,focusToggle?:string,
		selection?:ReturnType<ManagerView['rememberCommitSelection']>){
		if(lib.missing){
			new Setting(host).setName(lib.location).setDesc(tr('登记路径下找不到 kb.toml','The registered path has no kb.toml'))
				.addButton(b=>b.setButtonText(tr('重新定位','Relocate')).onClick(()=>relocateRegistryEntry(this.plugin,lib.location,host.win)))
				.addButton(b=>b.setButtonText(tr('移除登记','Remove')).onClick(async()=>{
					try{await removeRegistryEntry(this.plugin,lib.location,host.win);}catch(error){new Notice(String(error));}
				}));
			return;
		}
		const template=builtinPacks().find(pack=>pack.id===lib.identity?.template.id);
		const detail=[lib.location,template?.name ?? lib.identity?.template.id ?? tr('旧库',"Legacy"),({local:tr('独立 Git','Local Git'),missing:tr('未初始化 Git','Git not initialized'),special:tr('特殊 Git 布局','Special Git layout')})[lib.git], lib.identity?.archived ? tr('已归档',"Archived") : '',lib.problem,
			lib.duplicate ? tr('ID 重复，请核对两个目录',"Duplicate ID. Check both directories") : ''].filter(Boolean).join(' · ');
		const row=new Setting(host).setName(lib.identity?.displayName ?? lib.location).setDesc(detail);
		const key=lib.identity && !lib.problem && !lib.duplicate ? lib.identity.id : 'path:'+lib.location;
		if(!gitDisabled(this.plugin))row.addButton(button=>{
			button.buttonEl.setAttribute('aria-expanded',String(this.expanded===key));
			button.setButtonText(tr('Git 工作区','Git workspace')).onClick(()=>{
				this.selection=key;
				this.expanded=this.expanded===key ? undefined : key;
				this.saveLayout();
				void this.render(key);
			});
			if(focusToggle===key)button.buttonEl.focus();
		});
		if(this.expanded===key && (!lib.identity || lib.problem || lib.duplicate) && !gitDisabled(this.plugin)){
			const reason=lib.problem || (lib.duplicate ? tr('请先解决重复 ID','Resolve the duplicate ID first') : tr('接管此库后即可管理 Git','Adopt this library to manage Git'));
			host.createDiv({cls:'kb-library-git',text:reason});
		}
		if(!lib.identity || lib.problem || lib.duplicate)row.addButton(b=>b.setButtonText(tr('检验',"Check library")).onClick(async()=>{try{await checkLibrary(this.plugin,lib);}catch(error){new Notice(String(error));}}));
		if(lib.problem){
			row.addButton(b=>b.setButtonText(tr('移除登记','Remove')).onClick(async()=>{
				try{await removeRegistryEntry(this.plugin,lib.location,host.win);}catch(error){new Notice(String(error));}
			}));
			return;
		}
		if(lib.duplicate){
			row.addButton(b=>b.setButtonText(tr('标记为副本',"Mark as copy")).onClick(async()=>{
				try {await resolveDuplicate(this.plugin,lib,host.win);} catch(error){new Notice(String(error));}
			}));return;
		}
		if(!lib.identity) {
			row.addButton(b=>b.setButtonText(tr('预览接管',"Preview adoption")).onClick(async ()=>{
				try {
					const owner=host.win;
					const warnings=await adoptionWarnings(this.plugin.disk,lib);
					const dialog=new V3Dialog(this.app,tr('预览接管旧知识库',"Preview legacy library adoption"),owner);
					dialog.facts([[tr('清单','Manifest'),lib.location+'/kb.toml'],[tr('清单修改','Manifest change'),
						tr('新增 [manager] 和知识库 ID','Add [manager] and a library ID')]]);
					const mapping=Object.entries(lib.mapping ?? {});
					if(mapping.length){
						const paths=dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
						paths.createEl('summary',{text:tr('现有路径映射','Existing path mappings')});
						dialogContents(paths).facts(mapping.map(([key,value])=>[key,String(value)]));
					}
					if(warnings.length){
						dialog.contentEl.createEl('h3',{text:tr('需人工核对','Manual review required')});
						dialog.lines(warnings);
					}
					const candidate=await legacyBinding(this.plugin.disk,lib);
					const confirm=async(hash?:string)=>{
						await this.plugin.exclusive(lib.location,()=>adopt(this.plugin.disk,this.plugin.config,lib,warnings,hash));
						dialog.close();await this.plugin.refresh();
					};
					if(candidate){
						dialog.contentEl.createEl('p',{text:tr('可同时领管 knowledge.base 中匹配的库根、wiki 和 Notes 过滤条件。',
							'You can also let the manager maintain the matching root, wiki and Notes filters in knowledge.base.')});
					}
					dialog.action(tr('仅添加身份',"Add identity only"),()=>confirm()).setCta();
					if(candidate)dialog.action(tr('添加身份并领管已匹配的绑定',"Add identity and manage matched bindings"),()=>confirm(candidate));
					dialog.open();
				} catch(error){new Notice(String(error));}
			})); return;
		}
		const id=lib.identity.id;
		const location=lib.location;

		row.addExtraButton(button=>button.setIcon('ellipsis').setTooltip(tr('知识库操作','Library actions')).onClick(()=>{
			// A catalog update can finish while the visible row is still waiting for a history redraw.
			const lib=this.plugin.catalog.find(current=>current.location===location && current.identity?.id===id);
			if(!lib || lib.problem || lib.duplicate){
				new Notice(tr('知识库已变化，请刷新管理器。','The library changed. Refresh the manager.'));
				return;
			}
			const owner=button.extraSettingsEl.win;
			const menu=new Menu();
			const action=(title:string,icon:string,run:()=>void|Promise<void>)=>menu.addItem(item=>item.setTitle(title).setIcon(icon).onClick(async()=>{
				try{await run();}catch(error){new Notice(String(error));}
			}));
			if(!gitDisabled(this.plugin))action(tr('Git 工作区','Git workspace'),'git-branch',()=>this.showLibrary(id));
			action(tr('本库 Git 设置','Library Git settings'),'settings',()=>librarySettings(this.plugin,lib,owner));
			action(tr('编辑','Edit'),'pencil',()=>edit(this.plugin,lib,owner));
			if(!lib.identity?.archived)action(tr('移动','Move'),'folder-input',()=>move(this.plugin,lib,owner));
			action(tr('检验','Check library'),'activity',()=>checkLibrary(this.plugin,lib));
			action(tr('维护受管文件','Maintain managed files'),'file-cog',()=>maintainBindings(this.plugin,lib,owner));
			if(lib.templateFiles && !lib.identity?.archived)action(tr('更新受管模板文件','Update template files'),'package-check',()=>updateTemplateFiles(this.plugin,lib,owner));
			if(lib.identity?.schemaVersion===1 && !lib.identity.archived)action(tr('预览清单升级','Preview manifest upgrade'),'file-up',()=>upgradeManifest(this.plugin,lib,owner));
			action(tr('预览登记及路径绑定','Preview registration and bindings'),'map-pin',()=>showImportPreview(this.plugin,lib.location,undefined,undefined,owner));
			action(tr('移除登记','Remove registration'),'list-x',()=>removeRegistryEntry(this.plugin,lib.location,owner));
			const bounds=button.extraSettingsEl.getBoundingClientRect();
			menu.showAtPosition({x:bounds.left,y:bounds.bottom},button.extraSettingsEl.doc);
		}));
		row.addButton(b=>b.setButtonText(tr('打开',"Open")).onClick(async ()=>{
			const entry=lib.identity?.entry ?? lib.mapping?.index;
			if(!entry){
				const choices=new Dialog(this.app,lib.location,host.win);
				const files:TFile[]=[];
				const folder=this.app.vault.getFolderByPath(lib.location);
				if(folder)Vault.recurseChildren(folder,file=>{
					if(file instanceof TFile && file.extension.toLowerCase()==='md')files.push(file);
				});
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
			const panel=host.createDiv({cls:'kb-library-git',attr:{'data-kb-library-id':id}});
			watchLibraryChanges(this.plugin,lib,panel,signal,async()=>this.drawRow(lib));
			panel.createEl('h3',{text:tr('Git 工作区','Git workspace')+' · '+lib.identity.displayName});
			const tabs: {id:WorkspaceTab;label:string}[]=[{id:'changes',label:tr('更改','Changes')}];
			if(!lib.identity.archived && lib.git==='local')tabs.push({id:'remote',label:tr('远端与分支','Remote and branches')});
			const preferred=this.workspaceTabs.get(id);
			const initial=tabs.some(tab=>tab.id===preferred)?preferred:'changes';
			const rendered=new Set<WorkspaceTab>();
			const load=(tab:WorkspaceTab)=>{
				if(rendered.has(tab))return;
				rendered.add(tab);
				const content=panels[tab];
				const loading=content.createEl('p',{cls:'kb-workspace-meta',text:tr('正在读取 Git 状态…','Reading Git status…'),attr:{role:'status'}});
				const work=tab==='changes'?sourcePanel(this.plugin,lib,content,this.drafts,signal):
					networkPanel(this.plugin,lib,content,(icon,action)=>{if(!signal.aborted)this.networkActions.set(icon,action);});
				const done=work.catch(error=>{
					if(!signal.aborted)content.createEl('p',{cls:'kb-git-error',text:String(error),attr:{role:'alert'}});
				}).finally(()=>{
					loading.remove();
					if(tab==='changes' && !signal.aborted && selection?.id===id)
						selection.restore(content.querySelector('.kb-workspace-commit textarea'));
				});
				if(tab==='remote')this.networkReady=done;
			};
			const {panels,getActive}=createPanelTabs(panel,tr('Git 工作区','Git workspace'),tabs,initial,tab=>{
				this.workspaceTabs.set(id,tab);
				this.saveLayout();
				load(tab);
			});
			load(getActive());
		}

	}
	async create(){
		try{await createWizard(this.plugin,()=>this.plugin.refresh(),undefined,this.contentEl.win);}
		catch(error){new Notice(String(error),8000);}
	}
}
