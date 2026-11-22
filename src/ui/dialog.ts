import { App, Modal, Notice, Setting } from 'obsidian';
import { tr } from '../i18n.ts';
import { addTextField } from './text-field.ts';

type TextOptions = NonNullable<Parameters<typeof addTextField>[3]>;

export function dialogContents(contentEl: HTMLElement) {
	const text=(label: string, initial: string, change: (value: string)=>void, options: string|TextOptions = {}) =>
		addTextField(new Setting(contentEl).setName(label),initial,change,typeof options==='string'?{placeholder:options}:options);
	const multiline=(label: string, initial: string, change: (value: string)=>void, options: TextOptions = {}) =>
		addTextField(new Setting(contentEl).setName(label),initial,change,options,true);
	const choice=(label: string, options: Record<string,string>, change: (value:string)=>void, initial?:string) => {
		new Setting(contentEl).setName(label).addDropdown(input=>{
			input.selectEl.setAttribute('aria-label',label);
			input.addOptions(options);
			if(initial!==undefined)input.setValue(initial);
			input.onChange(change);
		});
	};
	const action=(label: string, action: (origin:HTMLButtonElement)=>Promise<void>) => {
		const row=new Setting(contentEl).setClass('kb-controls-only').setClass('kb-action-row');
		const errorEl=row.settingEl.createDiv({cls:'kb-action-error',attr:{role:'alert'}});
		errorEl.hidden=true;
		return row.addButton(button=>button.setButtonText(label).onClick(async ()=>{
			button.setDisabled(true);
			errorEl.hidden=true;
			try { await action(button.buttonEl); }
			catch (error) {
				if (errorEl.isConnected) {
					errorEl.hidden=false;
					errorEl.setText(String(error));
				} else new Notice(String(error),8000).messageEl.addClass('kb-notice-text');
			}
			finally { button.setDisabled(false); }
		})).components[0] as import('obsidian').ButtonComponent;
	};
	const lines=(lines: string[]) => { const list=contentEl.createEl('ul'); for(const line of lines) list.createEl('li',{text:line}); };
	const facts=(rows: readonly (readonly [string,string])[]) => {
		const list=contentEl.createEl('dl',{cls:'kb-preview-facts'});
		for(const [label,value] of rows){list.createEl('dt',{text:label});list.createEl('dd',{text:value});}
	};
	return {contentEl,text,multiline,choice,action,lines,facts};
}

export class Dialog extends Modal {
	private cancelOpen?:()=>void;
	private returnFocus?:HTMLElement;
	private readonly body = dialogContents(this.contentEl);
	readonly text = this.body.text;
	readonly multiline = this.body.multiline;
	readonly choice = this.body.choice;
	readonly action = this.body.action;
	readonly lines = this.body.lines;
	readonly facts = this.body.facts;
	constructor(app: App, title: string, readonly owner:Window=activeWindow) {
		super(app); this.modalEl.addClass('kb-dialog'); this.setTitle(title);
	}
	returnFocusTo(element:HTMLElement):this {
		this.returnFocus=element;
		return this;
	}
	override open(){
		this.cancelOpen?.();
		if(this.owner.closed)return;
		this.modalEl.removeAttribute('data-kb-closing');
		if(this.owner===activeWindow){super.open();return;}
		// Modal.open uses Obsidian's active window. Wait for the source window to receive focus.
		const owner=this.owner;
		const show=()=>{
			if(owner===activeWindow && !owner.closed){
				this.cancelOpen?.();
				super.open();
			}
		};
		const timer=owner.setTimeout(()=>{
			show();
			if(!this.cancelOpen)return;
			this.cancelOpen();
			if(!owner.closed)new Notice(tr('请先激活发起操作的窗口，然后重试。','Focus the window where you started the action and try again.'));
		},500);
		this.cancelOpen=()=>{
			owner.clearTimeout(timer);
			owner.removeEventListener('focus',show);
			this.cancelOpen=undefined;
		};
		owner.addEventListener('focus',show);
		owner.focus();
		show();
	}
	override close(){
		this.cancelOpen?.();
		this.modalEl.setAttribute('data-kb-closing','');
		super.close();
	}
	onClose() {
		this.contentEl.empty();
		const origin=this.returnFocus;
		if(!origin)return;
		this.returnFocus=undefined;
		// Obsidian restores its previous selection after close; wait before restoring the trigger.
		queueMicrotask(()=>{
			if(this.owner.closed||!origin.isConnected||origin.matches(':disabled')||origin.closest('.kb-dialog[data-kb-closing]'))return;
			const doc=this.owner.document;
			if(origin.ownerDocument!==doc)return;
			const active=doc.activeElement;
			if(active&&active!==doc.body&&!origin.closest('.modal-container')?.contains(active))return;
			origin.focus({preventScroll:true});
		});
	}
}

export class V3Dialog extends Dialog {
	constructor(app: App, title: string, owner?:Window) {
		super(app,title,owner);
		this.modalEl.addClass('kb-v3-dialog');
		this.containerEl.addClass('kb-v3-modal-container');
	}
}

export function showJsonPreview(app: App, title: string, value: object) {
	const dialog = new V3Dialog(app,title);
	dialog.contentEl.createEl('p',{text:tr(
		'选中内容后，用系统复制快捷键、右键菜单或长按菜单复制。',
		'Select text, then copy using your keyboard, the context menu, or the touch selection menu.',
	)});
	const input = dialog.contentEl.createEl('textarea',{
		cls:'kb-json-preview',
		attr:{'aria-label':title,readonly:'',rows:'12',spellcheck:'false',wrap:'off'},
	});
	input.value = JSON.stringify(value,null,2);
	new Setting(dialog.contentEl).setClass('kb-controls-only').addButton(button =>
		button.setButtonText(tr('全选','Select all')).onClick(() => {
			input.focus();
			input.select();
		}));
	dialog.open();
}
