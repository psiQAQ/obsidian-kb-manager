import { PluginSettingTab, Setting, Notice } from 'obsidian';
import type KnowledgeBaseManager from './main.ts';
import { validateFolders } from './fs/vault.ts';

export class ManagerSettings extends PluginSettingTab {
	private manager: KnowledgeBaseManager;
	constructor(manager: KnowledgeBaseManager) { super(manager.app,manager); this.manager=manager; }
	display(): void {
		this.containerEl.empty();
		const draft = {...this.manager.config};
		for (const [field,label] of [['parents','知识库父目录（每行一个，首行为默认位置）'],['templates','目录模板（每行一个 Vault 相对路径）']] as const) {
			new Setting(this.containerEl).setName(label).addTextArea(input=>input.setValue(draft[field].join('\n'))
				.onChange(value=>{draft[field]=value.split('\n').map(line=>line.trim()).filter(Boolean);}));
		}
		for (const [field,label] of [['author','本地 Git 作者'],['email','本地 Git 邮箱']] as const) {
			new Setting(this.containerEl).setName(label).addText(input=>input.setValue(draft[field]).onChange(value=>{draft[field]=value;}));
		}
		new Setting(this.containerEl).addButton(button=>button.setButtonText('保存设置').onClick(async ()=>{
			try {
				validateFolders(this.manager.disk,draft.parents,draft.templates);
				for(const name of [...draft.parents,...draft.templates]) await this.manager.disk.path(name);
				this.manager.config=draft;
				await this.manager.persist();
				await this.manager.refresh();
				new Notice('设置已保存');
			} catch(error) { new Notice(String(error)); }
		}));
	}
}
