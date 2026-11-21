import { AbstractInputSuggest, Setting, TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { tr } from '../i18n.ts';
import { identityFile } from '../kb/identity-core.ts';
import { compareRegistryPaths } from '../registry/paths.ts';
import type { Dialog } from './dialog.ts';

export function registryPathField(dialog:Dialog, app:App, mode:'manifest'|'folder') {
	let value = '';
	const manifest = mode === 'manifest';
	const label = manifest ? identityFile : tr('扫描目录','Folder to scan');
	new Setting(dialog.contentEl).setName(label).addText(input=>{
		input.setPlaceholder(manifest ? 'library/kb.toml' : 'folder/subfolder').onChange(path=>{value=path;});
		input.inputEl.setAttribute('aria-label',label);
		class SuggestPath extends AbstractInputSuggest<TFile|TFolder> {
			getSuggestions(query:string) {
				const path = query.trim();
				const split = path.lastIndexOf('/');
				const parent = split < 0 ? app.vault.getRoot() : app.vault.getFolderByPath(path.slice(0,split));
				const name = path.slice(split+1).toLowerCase();
				if (!parent) return [];
				return parent.children.filter((item):item is TFile|TFolder=>
					(item instanceof TFolder || (manifest && !parent.isRoot() && item instanceof TFile && item.name === identityFile)) &&
					item.name.toLowerCase().includes(name)).sort((a,b)=>compareRegistryPaths(a.name,b.name));
			}
			renderSuggestion(item:TFile|TFolder, el:HTMLElement) {
				el.setText(item instanceof TFolder ? item.path + '/' : item.path);
			}
		}
		const suggest = new SuggestPath(app,input.inputEl);
		suggest.onSelect(item=>{
			value = item instanceof TFolder ? item.path + '/' : item.path;
			input.setValue(value);
			suggest.close();
			if (item instanceof TFolder) input.inputEl.dispatchEvent(new Event('input',{bubbles:true}));
		});
	});
	return ()=> manifest ? value.trim() : value.trim().replace(/\/+$/u,'');
}
