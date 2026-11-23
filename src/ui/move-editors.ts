import {MarkdownView} from 'obsidian';
import type {TFile} from 'obsidian';
import {tr} from '../i18n.ts';
import type KnowledgeBaseManager from '../main.ts';

export function openMoveEditors(plugin: KnowledgeBaseManager) {
	const editors=new Map<TFile,string[]>();
	plugin.app.workspace.iterateAllLeaves(leaf=>{
		const view=leaf.view;
		if (!(view instanceof MarkdownView) || !view.file || view.getMode()!=='source') return;
		const values=editors.get(view.file) ?? [];
		values.push(view.editor.getValue());
		editors.set(view.file,values);
	});
	return editors;
}

const editorText=(text:string)=>text.replace(/^\uFEFF/u,'').replace(/\r\n/gu,'\n');

export function hasUnsavedMoveEditor(text:string,editors:readonly string[]) {
	return editors.some(value=>editorText(value)!==editorText(text));
}

export const saveMoveEditorMessage=()=>tr('请先保存编辑器中的修改并重新预览','Save the edits in the open editor and preview again');

export function verifyMoveEditors(path:string,text:string,editors:readonly string[]){
	if(hasUnsavedMoveEditor(text,editors)) throw new Error(saveMoveEditorMessage()+': '+path);
}
