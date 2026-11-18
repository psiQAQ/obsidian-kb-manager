import { ItemView, Notice, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { discover } from '../kb/catalog.ts';
import { adopt, legacyBinding, ancestorWarnings, createLibrary, previewCreate } from '../kb/create.ts';
import { resolveDuplicate } from './identity.ts';
import { edit,health,move,resumeMove } from './maintain.ts';
import { versions } from './versions.ts';
import { Dialog } from './dialog.ts';

export const managerType='knowledge-base-manager-view';
export class ManagerView extends ItemView {
	readonly plugin: KnowledgeBaseManager;
	constructor(leaf: WorkspaceLeaf,plugin: KnowledgeBaseManager) {super(leaf); this.plugin=plugin;}
	getViewType(){return managerType;}
	getDisplayText(){return '知识库管理器';}
	getIcon(){return 'library';}
	async onOpen(){await this.render();}
	async render(){
		const el=this.contentEl;
		el.empty();
		new Setting(el).setName('知识库').setHeading()
			.addButton(b=>b.setButtonText('新建').onClick(()=>this.create()))
			.addButton(b=>b.setButtonText('刷新').onClick(()=>this.render()));
		try {
			for(const record of Object.values(this.plugin.moves)){
				const row=new Setting(el).setName(record.source+' → '+record.destination).setDesc('移动阶段：'+record.phase);
				if(record.phase!=='complete')row.addButton(b=>b.setButtonText('复核并继续').onClick(async()=>{
					try{await resumeMove(this.plugin,record);}catch(error){new Notice(String(error),8000);}
				}));
			}
			const libraries=await discover(this.plugin.disk,this.plugin.config);
			if (!libraries.length) el.createEl('p',{text:'尚未发现知识库。可以新建知识库，或在设置中登记旧库的父目录。'});
			const before=JSON.stringify(this.plugin.known);
			for(const lib of libraries) {
				if(lib.identity && !lib.duplicate && !lib.problem)this.plugin.known[lib.identity.id]=lib.location;
				this.row(lib);
			}
			for(const [id,location] of Object.entries(this.plugin.known)) {
				if(!libraries.some(lib=>lib.identity?.id===id)) el.createEl('p',{text:'失联：'+location+' · '+id+'。在设置中登记当前位置的父目录并刷新，以库内 ID 重新定位。'});
			}
			if(before!==JSON.stringify(this.plugin.known))await this.plugin.persist();
		} catch(error) { el.createEl('p',{text:String(error)}); }
	}
	row(lib: Library){
		const detail=[lib.location,lib.identity?.template.id ?? '旧库',lib.git, lib.identity?.archived ? '已归档' : '',lib.problem,
			lib.duplicate ? 'ID 重复，请核对两个目录' : ''].filter(Boolean).join(' · ');
		const row=new Setting(this.contentEl).setName(lib.identity?.displayName ?? lib.location).setDesc(detail);
		row.addButton(b=>b.setButtonText('体检').onClick(async()=>{try{await health(this.plugin,lib);}catch(error){new Notice(String(error));}}));
		if(lib.problem)return;
		if(lib.duplicate){
			row.addButton(b=>b.setButtonText('标记为副本').onClick(async()=>{
				try {await resolveDuplicate(this.plugin,lib);} catch(error){new Notice(String(error));}
			}));return;
		}
		if(!lib.identity) {
			row.addButton(b=>b.setButtonText('预览接管').onClick(async ()=>{
				try {
					const warnings=await ancestorWarnings(this.plugin.disk,lib.location);
					const dialog=new Dialog(this.app,'接管旧知识库');
					dialog.lines([lib.location,'新增 kb-manager.json','Git：'+lib.git,...Object.entries(lib.mapping ?? {}).map(([k,v])=>k+' → '+String(v)),...warnings]);
					const candidate=await legacyBinding(this.plugin.disk,lib);
					const confirm=async(hash?:string)=>{
						await this.plugin.exclusive(lib.location,()=>adopt(this.plugin.disk,this.plugin.config,lib,warnings,hash));
						dialog.close();await this.render();
					};
					dialog.action('仅添加身份',()=>confirm());
					if(candidate){
						dialog.lines(['可领管 knowledge.base 的库根、wiki 和 Notes 过滤条件。其他字段由原作者维护。']);
						dialog.action('添加身份并领管已匹配的绑定',()=>confirm(candidate));
					}
					dialog.open();
				} catch(error){new Notice(String(error));}
			})); return;
		}
		row.addButton(b=>b.setButtonText('编辑').onClick(()=>edit(this.plugin,lib)));
		if(!lib.identity.archived)row.addButton(b=>b.setButtonText('移动').onClick(()=>move(this.plugin,lib)));
		for(const [mode,label] of [['save','保存版本'],['history','历史']] as const){
			if(lib.identity.archived && mode==='save')continue;
			row.addButton(b=>b.setButtonText(label).onClick(async()=>{
				try{await versions(this.plugin,lib,mode);}catch(error){new Notice(String(error),8000);}
			}));
		}
		row.addButton(b=>b.setButtonText('打开').onClick(async ()=>{
			const entry=lib.identity?.entry;
			if(!entry){
				const choices=new Dialog(this.app,lib.location);
				const files=this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith(lib.location+'/'));
				if(!files.length)choices.lines(['目录中没有 Markdown 文件。']);
				for(const file of files)choices.action(file.path.slice(lib.location.length+1),async()=>{
					await this.plugin.disk.path(file.path);await this.app.workspace.getLeaf(false).openFile(file);choices.close();
				});
				choices.open();return;
			}
			try {
				await this.plugin.disk.path(lib.location+'/'+entry);
				const file=this.app.vault.getAbstractFileByPath(lib.location+'/'+entry);
				if(file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
				else new Notice('入口不存在：'+entry);
			} catch(error){new Notice(String(error));}
		}));
	}
	create(){
		const {config,disk,skeleton}=this.plugin;
		const input={parent:config.parents[0] ?? '',name:'',displayName:'',description:'',source:''};
		const dialog=new Dialog(this.app,'新建知识库');
		dialog.choice('父目录',Object.fromEntries(config.parents.map(p=>[p,p])),v=>{input.parent=v;});
		dialog.choice('模板',{'':'内置 LLM Wiki',...Object.fromEntries(config.templates.map(p=>[p,p]))},v=>{input.source=v;});
		dialog.text('物理目录名','',v=>{input.name=v;});
		dialog.text('显示名（默认使用目录名）','',v=>{input.displayName=v;});
		dialog.text('简介','',v=>{input.description=v;});
		dialog.action('预览',async()=>{
			const preview=await previewCreate(disk,config,{...input,displayName:input.displayName||input.name},skeleton);
			const confirm=new Dialog(this.app,'确认创建');
			confirm.lines([preview.location,...preview.warnings,...preview.template.folders.map(p=>p+'/'),
				...preview.template.files.map(f=>f.name), 'kb-manager.json','.git/（main，空历史）',
				...preview.template.excluded.map(p=>'排除 '+p)]);
			confirm.action('创建',async()=>{await createLibrary(disk,this.plugin.config,preview,skeleton);confirm.close();dialog.close();await this.render();});
			confirm.open();
		});dialog.open();
	}
}
