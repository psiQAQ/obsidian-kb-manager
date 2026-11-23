import {ButtonComponent, Notice, setTooltip, TFile, Vault} from 'obsidian';
import type {Setting} from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type {Library} from '../kb/catalog.ts';
import {tr} from '../i18n.ts';
import {Dialog} from './dialog.ts';

export function cardAction(parent:HTMLElement,label:string,icon:string,run:()=>void|Promise<void>){
	const button=new ButtonComponent(parent).setClass('clickable-icon').setClass('kb-card-action')
		.setIcon(icon).setTooltip(label,{placement:'right'}).onClick(async()=>{
			try{await run();}catch(error){new Notice(String(error));}
		});
	button.buttonEl.type='button';
	button.buttonEl.setAttribute('aria-label',label);
	return button.buttonEl;
}

export function libraryCardHeading(host:HTMLElement,row:Setting,name:string,open:()=>Promise<void>){
	row.setClass('kb-library-card-summary');
	const title=host.createEl('button',{cls:'kb-card-open',attr:{type:'button'}});
	host.prepend(title);
	const label=tr('打开知识库','Open library')+' · '+name;
	title.setAttribute('aria-label',label);
	setTooltip(title,label);
	title.addEventListener('click',()=>{void open().catch(error=>new Notice(String(error)));});
	row.controlEl.setAttribute('role','group');
	row.controlEl.setAttribute('aria-label',tr('知识库操作','Library actions')+' · '+name);
}

export async function openLibrary(plugin:KnowledgeBaseManager,lib:Library,owner:Window){
	const entry=lib.identity?.entry ?? lib.mapping?.index;
	if(entry){
		const path=lib.location+'/'+entry;
		await plugin.disk.path(path);
		const file=plugin.app.vault.getAbstractFileByPath(path);
		if(file instanceof TFile)await plugin.app.workspace.getLeaf(false).openFile(file);
		else new Notice(tr('入口不存在：','Entry not found: ')+entry);
		return;
	}
	const choices=new Dialog(plugin.app,lib.location,owner);
	const files:TFile[]=[];
	const folder=plugin.app.vault.getFolderByPath(lib.location);
	if(folder)Vault.recurseChildren(folder,file=>{
		if(file instanceof TFile && file.extension.toLowerCase()==='md')files.push(file);
	});
	if(!files.length)choices.lines([tr('目录中没有 Markdown 文件。','This directory has no Markdown files.')]);
	for(const file of files)choices.action(file.path.slice(lib.location.length+1),async()=>{
		await plugin.disk.path(file.path);
		await plugin.app.workspace.getLeaf(false).openFile(file);
		choices.close();
	});
	choices.open();
}
