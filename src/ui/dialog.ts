import { App, Modal, Notice, Setting } from 'obsidian';
import { addTextField } from './text-field.ts';

type TextOptions = NonNullable<Parameters<typeof addTextField>[3]>;

export class Dialog extends Modal {
	constructor(app: App, title: string) { super(app); this.modalEl.addClass('kb-dialog'); this.setTitle(title); }
	text(label: string, initial: string, change: (value: string)=>void, options: string|TextOptions = {}) {
		return addTextField(new Setting(this.contentEl).setName(label),initial,change,typeof options==='string'?{placeholder:options}:options);
	}
	multiline(label: string, initial: string, change: (value: string)=>void, options: TextOptions = {}) {
		return addTextField(new Setting(this.contentEl).setName(label),initial,change,options,true);
	}
	choice(label: string, options: Record<string,string>, change: (value:string)=>void) {
		new Setting(this.contentEl).setName(label).addDropdown(input=>input.addOptions(options).onChange(change));
	}
	action(label: string, action: ()=>Promise<void>) {
		const row=new Setting(this.contentEl);
		const errorEl=row.settingEl.createDiv({cls:'kb-action-error',attr:{role:'alert'}});
		errorEl.hidden=true;
		return row.addButton(button=>button.setButtonText(label).onClick(async ()=>{
			button.setDisabled(true);
			errorEl.hidden=true;
			try { await action(); }
			catch (error) {
				if (errorEl.isConnected) {
					errorEl.setText(String(error));
					errorEl.hidden=false;
				} else new Notice(String(error),8000).messageEl.addClass('kb-notice-text');
			}
			finally { button.setDisabled(false); }
		})).components[0] as import('obsidian').ButtonComponent;
	}
	lines(lines: string[]) { const list=this.contentEl.createEl('ul'); for(const line of lines) list.createEl('li',{text:line}); }
	facts(rows: readonly (readonly [string,string])[]) {
		const list=this.contentEl.createEl('dl',{cls:'kb-preview-facts'});
		for(const [label,value] of rows){list.createEl('dt',{text:label});list.createEl('dd',{text:value});}
	}
	onClose() { this.contentEl.empty(); }
}
