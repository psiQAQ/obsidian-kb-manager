import { App, Modal, Notice, Setting } from 'obsidian';

export class Dialog extends Modal {
	constructor(app: App, title: string) { super(app); this.setTitle(title); }
	text(label: string, initial: string, change: (value: string)=>void, placeholder = '') {
		new Setting(this.contentEl).setName(label).addText(input=>input.setPlaceholder(placeholder).setValue(initial).onChange(change));
	}
	choice(label: string, options: Record<string,string>, change: (value:string)=>void) {
		new Setting(this.contentEl).setName(label).addDropdown(input=>input.addOptions(options).onChange(change));
	}
	action(label: string, action: ()=>Promise<void>) {
		new Setting(this.contentEl).addButton(button=>button.setButtonText(label).onClick(async ()=>{
			button.setDisabled(true);
			try { await action(); } catch (error) { new Notice(String(error),8000); }
			finally { button.setDisabled(false); }
		}));
	}
	lines(lines: string[]) { const list=this.contentEl.createEl('ul'); for(const line of lines) list.createEl('li',{text:line}); }
	onClose() { this.contentEl.empty(); }
}
