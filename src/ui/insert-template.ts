import { MarkdownView, Notice, TFile, TFolder, moment } from 'obsidian';
import * as path from 'node:path';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { statIfPresent } from '../fs/vault.ts';
import { insertTemplate } from '../kb/insert.ts';
import { Dialog } from './dialog.ts';
import { tr } from '../i18n.ts';

async function checkedFile(plugin:KnowledgeBaseManager,root:string,file:TFile) {
	if(!file.path.startsWith(root+'/')) throw new Error(tr('文件已移动','The file moved'));
	const absolute=await plugin.disk.path(file.path);
	const stat=await statIfPresent(absolute);
	if(!stat?.isFile() || stat.nlink!==1) throw new Error(tr('需要独立常规文件','Expected a regular file with one link'));
	const boundary=await plugin.disk.path(root);
	for(let dir=path.dirname(absolute);dir!==boundary;dir=path.dirname(dir)){
		for(const marker of ['.git','kb.toml','kb-manager.json']){
			if(await statIfPresent(path.join(dir,marker))) throw new Error(tr('文件属于嵌套库','File belongs to a nested library'));
		}
	}
}

async function choose(plugin:KnowledgeBaseManager,view:MarkdownView,target:TFile){
	const lib=(await discover(plugin.disk,plugin.config)).find(item=>target.path.startsWith(item.location+'/'));
	if(!lib?.identity || lib.problem || lib.duplicate || lib.identity.archived) throw new Error(tr('请选择可写知识库中的笔记','Select a note in a writable library'));
	const targetPath=target.path;
	await checkedFile(plugin,lib.location,target);
	const folder=lib.location+'/'+(lib.mapping?.templates ?? (lib.identity.template.id==='kepano'?'Templates':'templates'))+'/';
	const files:TFile[]=[];
	async function collect(dir:TFolder){
		const absolute=await plugin.disk.path(dir.path);
		for(const marker of ['.git','kb.toml','kb-manager.json']){
			if(await statIfPresent(path.join(absolute,marker))) return;
		}
		for(const child of dir.children){
			if(child instanceof TFolder) await collect(child);
			else if(child instanceof TFile && child.extension==='md' && child!==target) files.push(child);
		}
	}
	const templates=plugin.app.vault.getAbstractFileByPath(folder.slice(0,-1));
	if(templates instanceof TFolder) await collect(templates);
	files.sort((a,b)=>a.path.localeCompare(b.path));
	let selected=files[0]?.path;
	if(!selected) throw new Error(tr('本库没有页面模板','No page templates in this library'));
	const picker=new Dialog(plugin.app,tr('插入本库页面模板','Insert library template'));
	picker.lines([targetPath]);
	picker.choice(tr('页面模板','Page template'),Object.fromEntries(files.map(f=>[f.path,f.path.slice(folder.length)])),v=>{selected=v;});
	picker.action(tr('预览','Preview'),async()=>{
		const file=files.find(f=>f.path===selected);
		if(!file) throw new Error(tr('请重新选择模板','Select a template again'));
		await checkedFile(plugin,lib.location,file);
		const bytes=await plugin.app.vault.read(file);
		const editor=view.editor, note=editor.getValue(), now=moment();
		const result=insertTemplate(note,bytes,editor.posToOffset(editor.getCursor()),target.basename,(kind,pattern)=>now.format(pattern || (kind==='date'?'YYYY-MM-DD':'HH:mm')));
		const preview=new Dialog(plugin.app,tr('预览插入','Preview insertion'));
		preview.lines([targetPath,file.path,...result.conflicts.map(k=>tr('保留现有属性：','Keep existing property: ')+k)]);
		preview.contentEl.createEl('pre',{text:result.text});
		preview.action(tr('插入','Insert'),async()=>{
			await plugin.exclusive(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await checkedFile(plugin,lib.location,target);
				await checkedFile(plugin,lib.location,file);
				if(await plugin.app.vault.read(file)!==bytes || file.path!==selected || view!==plugin.app.workspace.getActiveViewOfType(MarkdownView) || view.file!==target || target.path!==targetPath || editor.getValue()!==note) throw new Error(tr('目标或模板已变化，请重新预览','Target or template changed. Preview again.'));
				editor.transaction({changes:[{from:{line:0,ch:0},to:editor.offsetToPos(note.length),text:result.text}]});
				editor.setCursor(editor.offsetToPos(result.cursor));
			});
			preview.close();picker.close();
		});
		preview.open();
	});
	picker.open();
}

export function registerLibraryTemplates(plugin:KnowledgeBaseManager){
	plugin.addCommand({id:'insert-library-template',name:tr('插入本库页面模板','Insert library template'),editorCallback:async()=>{
		const view=plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if(!view?.file)return;
		try{await choose(plugin,view,view.file);}catch(error){new Notice(String(error));}
	}});
}
