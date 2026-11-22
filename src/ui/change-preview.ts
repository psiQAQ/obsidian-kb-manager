import { ButtonComponent, Notice } from 'obsidian';
import { tr } from '../i18n.ts';

export function panelGroup(parent:HTMLElement,title?:string):HTMLElement {
	const group=parent.createDiv({cls:'kb-panel-group'});
	if(title)group.createEl('h3',{cls:'kb-panel-group-title',text:title});
	return group;
}

export function changeActions(parent:HTMLElement,actions:readonly {label:string;run:(origin:HTMLButtonElement)=>Promise<void>;primary?:boolean}[]) {
	const footer=parent.createDiv({cls:'kb-change-actions'});
	const controls=footer.createDiv({cls:'kb-change-action-buttons'});
	const errorEl=footer.createDiv({cls:'kb-action-error',attr:{role:'alert'}});
	errorEl.hidden=true;
	let disabled=false, busy=false;
	const buttons=actions.map(({label,run,primary})=>{
		const button=new ButtonComponent(controls).setButtonText(label);
		if(primary)button.setCta();
		button.onClick(async()=>{
			if(disabled||busy)return;
			const restoreFocus=button.buttonEl===controls.doc.activeElement;
			busy=true;
			controls.setAttribute('aria-busy','true');
			updateButtons();
			errorEl.hidden=true;
			errorEl.empty();
			try { await run(button.buttonEl); }
			catch(error){
				if(errorEl.isConnected){
					errorEl.hidden=false;
					errorEl.setText(String(error));
				} else new Notice(String(error),8000).messageEl.addClass('kb-notice-text');
			} finally {
				busy=false;
				controls.removeAttribute('aria-busy');
				updateButtons();
				if(restoreFocus&&!disabled&&button.buttonEl.isConnected&&controls.doc.activeElement===controls.doc.body){
					button.buttonEl.focus();
				}
			}
		});
		return button;
	});
	function updateButtons(){
		for(const button of buttons)button.setDisabled(disabled||busy);
	}
	return {setDisabled(value:boolean){ disabled=value; updateButtons(); }};
}

export function changeComparison(parent:HTMLElement,rows:readonly {
	label:string; before:string; after:string; afterLabel?:string; code?:boolean;
}[]):void {
	if(!rows.length)return;
	const comparison=parent.createDiv({cls:'kb-change-comparison'});
	for(const {label,before,after,afterLabel,code} of rows){
		const field=comparison.createDiv({cls:'kb-change-field'});
		field.createEl('h3',{cls:'kb-change-field-title',text:label});
		const pair=field.createEl('dl',{cls:'kb-change-pair'});
		for(const [heading,value] of [[tr('变更前','Before'),before],[afterLabel??tr('变更后','After'),after]] as const){
			const side=pair.createDiv({cls:'kb-change-side'});
			side.createEl('dt',{text:heading});
			const output=side.createEl('dd');
			if(value==='')output.createSpan({cls:'kb-change-empty',text:code?tr('空内容','Empty content'):tr('未填写','Not set')});
			else if(code){
				output.addClass('kb-change-code');
				output.setAttribute('aria-label',label+' · '+heading);
				output.tabIndex=0;
				output.createEl('code',{text:value});
			} else output.setText(value);
		}
	}
}
