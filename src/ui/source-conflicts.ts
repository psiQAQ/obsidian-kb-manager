import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { discover,recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { conflictFiles } from '../git/index-history.ts';
import { verifyWorkingFile } from '../git/index-actions.ts';
import { parseConflictBlocks, resolveBlock } from '../git/index-conflicts.ts';
import type { ConflictBlock,ConflictChoice } from '../git/index-conflicts.ts';
import { gitDisabled,pluginNotice } from './device.ts';
import { Dialog } from './dialog.ts';

const labels:Record<ConflictChoice,[string,string]>={
	ours:['保留本地','Keep ours'],theirs:['保留对方','Keep theirs'],base:['保留共同祖先','Keep base'],both:['保留两者','Keep both'],
};
const decorations=StateEffect.define<DecorationSet>();
const field=StateField.define<DecorationSet>({
	create:()=>Decoration.none,
	update:(value,transaction)=>{
		for(const effect of transaction.effects)if(effect.is(decorations))return effect.value;
		return transaction.docChanged?Decoration.none:value;
	},
	provide:f=>EditorView.decorations.from(f),
});

function enabled(plugin:KnowledgeBaseManager,lib:Library,view:EditorView){
	if(gitDisabled(plugin) || !lib.identity || lib.identity.archived)return false;
	const mode=plugin.preferences(lib.identity.id).conflictResolutionMode;
	const live=view.state.field(editorLivePreviewField,false);
	return mode==='both' || mode===(live?'live-preview':'source');
}

class ConflictButtons extends WidgetType {
	constructor(private plugin:KnowledgeBaseManager,private lib:Library,private path:string,private block:ConflictBlock,private raw:string){super();}
	toDOM(view:EditorView){
		const {plugin,lib,path,block}=this;
		const el=view.dom.doc.createDocumentFragment().createSpan({cls:'kb-conflict-controls'});
		const choices:ConflictChoice[]=block.base===undefined?['ours','theirs','both']:['ours','base','theirs','both'];
		for(const choice of choices){
			const label=plugin.t(...labels[choice]);
			const button=el.createEl('button',{text:label,attr:{type:'button'}});
			button.onmousedown=event=>event.preventDefault();
			button.onclick=event=>{
				event.preventDefault();event.stopPropagation();
				const doc=view.state.doc;
				const before=doc.sliceString(block.from,block.to);
				if(before!==this.raw || !enabled(plugin,lib,view) || this.path!==view.state.field(editorInfoField,false)?.file?.path){
					pluginNotice(plugin,'error',plugin.t('冲突块已变化，请重新预览','The conflict block changed. Reopen the preview.'),lib.identity?.id);
					return;
				}
				const next=resolveBlock(block,choice);
				const dialog=new Dialog(plugin.app,label);
				dialog.lines([path,plugin.t('原冲突块','Original conflict block')]);
				dialog.contentEl.createEl('pre',{text:before});
				dialog.lines([plugin.t('应用后的内容','Replacement text')]);
				dialog.contentEl.createEl('pre',{text:next});
				dialog.action(plugin.t('替换编辑器中的此块','Replace this block in the editor'),async()=>{
					await plugin.exclusiveGit(lib.location,async()=>{
						await recheck(plugin.disk,plugin.config,lib);
						const dir=await plugin.disk.path(lib.location);
						const relative=path.slice(lib.location.length+1);
						await verifyWorkingFile(dir,relative);
						const conflicts=await conflictFiles(dir);
						if(!enabled(plugin,lib,view) || !view.dom.isConnected || view.state.doc!==doc ||
							view.state.readOnly || view.state.field(editorInfoField,false)?.file?.path!==path || !conflicts.includes(relative))
							throw new Error(plugin.t('目标或内容已变化，请重新预览','The target or content changed. Reopen the preview.'));
						view.dispatch({changes:{from:block.from,to:block.to,insert:next},userEvent:'input'});
					});
					dialog.close();view.focus();
				});
				dialog.open();
			};
		}
		return el;
	}
}

export function registerConflictEditor(plugin:KnowledgeBaseManager,updates:Set<()=>void>){
	plugin.registerEditorExtension([field,ViewPlugin.fromClass(class{
		private view:EditorView;
		private generation=0;
		private timer?:number;
		private cached?:{path:string;lib?:Library};
		private refresh=()=>{this.cached=undefined;this.schedule();};
		constructor(view:EditorView){this.view=view;updates.add(this.refresh);this.schedule();}
		update(update:ViewUpdate){
			if(update.startState.field(editorInfoField,false)?.file?.path!==this.file()?.path ||
				update.startState.field(editorLivePreviewField,false)!==this.view.state.field(editorLivePreviewField,false))this.refresh();
			else if(update.docChanged){
				if(!this.cached?.lib)this.cached=undefined;
				this.schedule();
			}
		}
		private file(){return this.view.state.field(editorInfoField,false)?.file;}
		private schedule(){
			window.clearTimeout(this.timer);
			const token=++this.generation;
			this.timer=window.setTimeout(()=>{void this.paint(token).catch(error=>{
				if(token===this.generation){
					this.view.dispatch({effects:decorations.of(Decoration.none)});
					pluginNotice(plugin,'error',String(error));
				}
			});},160);
		}
		private async paint(token:number){
			const view=this.view,doc=view.state.doc,file=this.file();
			let next=Decoration.none;
			if(file?.extension==='md' && !view.state.readOnly && !gitDisabled(plugin)){
				const text=doc.toString();
				const blocks=text.includes('<<<<<<<')?parseConflictBlocks(text):[];
				if(blocks.length){
					const path=file.path;
					if(this.cached?.path!==path){
						const lib=(await discover(plugin.disk,plugin.config)).find(l=>l.identity && !l.duplicate && !l.problem && l.git==='local' && path.startsWith(l.location+'/'));
						const inConflict=lib && enabled(plugin,lib,view) && (await conflictFiles(await plugin.disk.path(lib.location))).includes(path.slice(lib.location.length+1));
						if(token!==this.generation)return;
						this.cached={path,lib:inConflict?lib:undefined};
					}
					const lib=this.cached.lib;
					if(lib && enabled(plugin,lib,view)){
					const heading=Decoration.line({class:'kb-conflict-heading'});
					next=Decoration.set(blocks.flatMap(block=>[
						heading.range(doc.lineAt(block.headingEnd).from),
						Decoration.widget({side:1,widget:new ConflictButtons(plugin,lib,path,block,text.slice(block.from,block.to))}).range(block.headingEnd),
					]),true);
					}
				}
			}
			if(token===this.generation)view.dispatch({effects:decorations.of(next)});
		}
		destroy(){this.generation++;window.clearTimeout(this.timer);updates.delete(this.refresh);}
	})]);
}
