import { Notice, Setting, TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { tr } from '../i18n.ts';
import { identityFile } from '../kb/identity-core.ts';
import { compareRegistryPaths, registryKey, sameOrBelow, validateRegistryPath } from '../registry/paths.ts';
import type { PluginDataRegistry } from '../registry/plugin-data.ts';
import { Dialog } from './dialog.ts';

interface Options {
	label?:string;
	favorites?:readonly string[];
	allowNew?:boolean;
	destination?:{templates:readonly string[];registry:PluginDataRegistry};
}

function openPathPicker(app:App, mode:'manifest'|'folder', options:Options, blocked:string[], select:(path:string)=>void) {
	const manifest=mode==='manifest', rootLabel=tr('Vault 根目录（/）','Vault root (/)');
	const root=app.vault.getRoot();
	const picker=new Dialog(app,manifest?tr('浏览知识库清单','Browse library manifests'):tr('浏览 Vault 目录','Browse Vault folders'));
	let folder=root, typed='';
	const currentPath=picker.contentEl.createEl('p');
	const actions=picker.contentEl.createDiv();
	const favorites=picker.contentEl.createDiv();
	const items=picker.contentEl.createDiv();
	const unavailable=(path:string)=>{
		try { validateRegistryPath(path,app.vault.configDir); }
		catch { return true; }
		return blocked.some(prefix=>sameOrBelow(registryKey(path),prefix));
	};
	const hasManifest=(dir:TFolder)=>dir.children.some(item=>item instanceof TFile && registryKey(item.name)===identityFile);
	function usable(dir:TFolder) {
		for(let current:TFolder|null=dir;current;current=current.parent){
			if((!current.isRoot() && unavailable(current.path)) || (options.destination && hasManifest(current)))return false;
		}
		return true;
	}
	function finish(path:string) {
		select(path);
		picker.close();
	}
	function browse(next:TFolder) {
		folder=next;
		const isRoot=folder.isRoot(), current=isRoot?'':folder.path;
		currentPath.setText(isRoot?rootLabel:current);
		actions.empty();favorites.empty();items.empty();
		new Setting(actions).setClass('kb-controls-only')
			.addButton(button=>button.setButtonText(tr('上一级','Up one folder')).setDisabled(isRoot).onClick(()=>browse(folder.parent??root)))
			.addButton(button=>{
				button.buttonEl.hidden=manifest;
				button.setButtonText(isRoot?tr('选择 Vault 根目录','Select Vault root'):tr('选择当前目录','Select this folder')).setCta()
					.setDisabled(!usable(folder)).onClick(()=>finish(current));
			});
		if(isRoot && options.favorites?.length){
			for(const path of new Set(options.favorites)){
				if(unavailable(path))continue;
				const favorite=app.vault.getFolderByPath(path);
				if(favorite ? !usable(favorite) : !options.allowNew)continue;
				new Setting(favorites).setName(path).setDesc(tr('收藏目录','Favorite folder')).addButton(button=>{
					button.setButtonText(tr('选择','Select')).onClick(()=>finish(path));
				});
			}
		}
		const entries=items.createDiv();
		const visible=folder.children.filter(item=>(item instanceof TFolder && usable(item)) ||
			(manifest && !isRoot && item instanceof TFile && item.name===identityFile && !unavailable(item.path)))
			.sort((a,b)=>compareRegistryPaths(a.name,b.name));
		function filter(query:string) {
			entries.empty();
			const matches=visible.filter(item=>registryKey(item.name).includes(registryKey(query.trim())));
			for(const item of matches){
				new Setting(entries).setName(item.name).addButton(button=>{
					if(item instanceof TFolder)button.setButtonText(tr('打开','Open')).onClick(()=>browse(item));
					else button.setButtonText(tr('选择','Select')).onClick(()=>finish(item.path));
				});
			}
			if(!matches.length)entries.createEl('p',{text:tr('当前目录没有匹配项','No matches in this folder')});
		}
		const label=tr('筛选当前目录','Filter this folder');
		new Setting(items).setName(label).addSearch(field=>{
			field.inputEl.setAttribute('aria-label',label);
			field.onChange(filter);
		});
		items.appendChild(entries);
		filter('');
	}
	browse(root);
	const label=manifest?tr('输入清单的 Vault 相对路径','Enter a vault-relative manifest path'):
		options.allowNew?tr('输入父目录的 Vault 相对路径','Enter a vault-relative parent folder'):
			tr('输入已有目录的 Vault 相对路径','Enter an existing vault-relative folder');
	picker.text(label,'',value=>{typed=value;},{example:manifest?'library/kb.toml':'folder/subfolder'});
	picker.action(tr('使用输入的路径','Use entered path'),()=>{
		if(unavailable(typed))throw new Error(tr('请选择 Vault 中可用的相对路径','Choose an available vault-relative path'));
		if(manifest && !typed.endsWith('/'+identityFile))
			throw new Error(tr('请选择知识库根目录中的 kb.toml','Select kb.toml at the library root'));
		const existing=app.vault.getFolderByPath(typed);
		if(options.destination && existing && !usable(existing))throw new Error(tr('请选择知识库之外的目录','Choose a folder outside existing libraries'));
		finish(typed);
		return Promise.resolve();
	});
	picker.open();
}

export function registryPathField(dialog:Dialog, app:App, mode:'manifest'|'folder', options:Options={}) {
	let selected:string|null = null;
	const label = options.label ?? (mode === 'manifest' ? identityFile : tr('扫描目录','Folder to scan'));
	const browse=tr('浏览…','Browse…'), placeholder=mode==='manifest'?tr('选择清单','Select a manifest'):tr('选择目录','Select a folder');
	const row = new Setting(dialog.contentEl).setName(label);
	if(options.allowNew) row.setDesc(tr('可输入相对路径，并在创建知识库时建立缺失的父目录。',
		'You can enter a relative path and create any missing parent folders with the library.'));
	row.addText(input=>{
		input.setPlaceholder(placeholder);
		input.inputEl.readOnly=true;
		input.inputEl.setAttribute('aria-label',label);
		let opening=false;
		const open=async()=>{
			if(opening)return;
			opening=true;
			try {
				const registered=await options.destination?.registry.read();
				const blocked=[...(options.destination?.templates??[]),...(registered?.paths??[])].map(registryKey);
				openPathPicker(app,mode,options,blocked,path=>{
					selected=path;
					input.setValue(path || tr('Vault 根目录（/）','Vault root (/)'));
				});
			} catch(error) { new Notice(String(error)); }
			finally { opening=false; }
		};
		input.inputEl.addEventListener('click',()=>void open());
		input.inputEl.addEventListener('keydown',event=>{
			if(event.key==='Enter' || event.key===' '){event.preventDefault();void open();}
		});
		row.addButton(button=>button.setButtonText(browse).onClick(open));
	});
	return () => {
		if (selected === null) throw new Error(placeholder);
		return selected;
	};
}

export function destinationParentField(dialog:Dialog,app:App,config:{parents:string[];templates:string[]},registry:PluginDataRegistry,allowNew=false) {
	return registryPathField(dialog,app,'folder',{
		label:tr('目标父目录','Destination parent folder'),favorites:config.parents,allowNew,
		destination:{templates:config.templates,registry},
	});
}
