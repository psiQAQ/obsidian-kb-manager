import {EditorState} from '@codemirror/state';
import {EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers} from '@codemirror/view';
import {TFile, TFolder} from 'obsidian';
import {readdir} from 'node:fs/promises';
import {baseExpressionLine} from '../diagnostics/base-expression-location.ts';
import type {BaseExpression} from '../diagnostics/types.ts';
import {decode, readRelative} from '../diagnostics/snapshot.ts';
import {tr} from '../i18n.ts';
import type KnowledgeBaseManager from '../main.ts';
import {V3Dialog} from './dialog.ts';

class SourceLocationDialog extends V3Dialog {
	private editor?: EditorView;
	private initialLayout?: ResizeObserver;
	private initialScroll?: number;

	constructor(plugin:KnowledgeBaseManager, private file:string, private source:string, private line:number|undefined, origin:HTMLElement, private message?:string) {
		super(plugin.app,file+(line ? ' · '+tr('第 ','Line ')+line+tr(' 行','') : ''),origin.win);
		this.returnFocusTo(origin);
	}

	onOpen() {
		const doc=EditorState.create({doc:this.source}).doc;
		const target=this.line && this.line<=doc.lines ? doc.line(this.line) : undefined;
		if(this.message)this.contentEl.createEl('p',{attr:{role:'status'},text:this.message});
		if(this.line && !target)this.contentEl.createEl('p',{attr:{role:'status'},text:
			tr('报告中的行已超出当前文件范围。当前行数','The reported line is outside the current file. Current line count')+' · '+doc.lines});
		const label=tr('当前文件源码（只读）','Current file source (read-only)');
		this.contentEl.createEl('p',{cls:'kb-v3-muted',text:label});
		this.modalEl.addClass('kb-source-location');
		this.editor=new EditorView({parent:this.contentEl,state:EditorState.create({
			doc,selection:{anchor:target?.from ?? 0},
			extensions:[lineNumbers(), EditorState.readOnly.of(true),EditorView.editable.of(false),
				EditorView.contentAttributes.of({'aria-label':label+' · '+this.file,'tabindex':'0'}),
				...(target ? [highlightActiveLine(),highlightActiveLineGutter()] : [])],
		})});
		this.editor.focus();
		if(target){
			const editor=this.editor;
			// The modal can still be acquiring its theme-dependent height in onOpen.
			// Center once the scroller has a real viewport, including for virtualized lines.
			const center=()=>{
				const scroller=editor.scrollDOM;
				const pane=scroller.getBoundingClientRect();
				if(!pane.height || !editor.dom.isConnected)return;
				const active=editor.contentDOM.querySelector('.cm-activeLine')?.getBoundingClientRect();
				const line=editor.lineBlockAt(target.from);
				const middle=active?.height ? active.top+active.height/2 : editor.documentTop+line.top+line.height/2;
				scroller.scrollTop+=middle-pane.top-pane.height/2;
				this.initialLayout?.disconnect();
			};
			this.initialLayout=new ResizeObserver(center);
			this.initialLayout.observe(editor.scrollDOM);
			// A background vault may defer paint callbacks. Layout can still be
			// measured after Modal.open has attached the content.
			this.initialScroll=this.owner.setTimeout(center,0);
		}
	}

	override onClose(){
		this.owner.clearTimeout(this.initialScroll);
		this.initialLayout?.disconnect();
		this.editor?.destroy();
		super.onClose();
	}
}

export async function openDiagnosticLocation(plugin:KnowledgeBaseManager,location:string,file:string,line:number|undefined,
	origin:HTMLElement,closeReport:()=>void,detail?:BaseExpression|'excluded') {
	if(detail==='excluded'){
		// An excluded entry may itself be hidden, a symlink or a separate library.
		// Locate its name in the validated parent without opening the entry.
		const parts=file.split('/');
		const name=parts.pop()!;
		const parent=[location,...parts].filter(Boolean).join('/');
		const dir=await plugin.disk.folder(parent);
		const entries=(await readdir(dir)).sort();
		const index=entries.indexOf(name);
		if(index<0)throw new Error(tr('所在目录中找不到此项','Entry no longer present in its folder')+' · '+file);
		if(!origin.isConnected)return;
		const dialog=new V3Dialog(plugin.app,tr('跳过项的位置','Skipped entry location'),origin.win).returnFocusTo(origin);
		dialog.contentEl.createEl('p',{text:tr('所在目录','Containing folder')+' · '+(parent || '/')});
		const list=dialog.contentEl.createEl('ul');
		for(const entry of entries.slice(Math.max(0,index-2),index+3)){
			const row=list.createEl('li');
			if(entry===name)row.createEl('mark',{text:entry});
			else row.setText(entry);
		}
		dialog.open();
		return;
	}
	const path=[location,file].filter(Boolean).join('/');
	await plugin.disk.path(path);
	const entry=plugin.app.vault.getAbstractFileByPath(path);
	if(!origin.isConnected)return;
	if(entry instanceof TFolder){
		const folder=new V3Dialog(plugin.app,path,origin.win).returnFocusTo(origin);
		folder.contentEl.createEl('p',{text:tr('目录内容','Folder contents')});
		folder.lines(entry.children.map(child=>child.name).sort());
		folder.open();
		return;
	}
	// Sources with line coordinates must remain visible above the report. The native Bases
	// view renders a table and cannot navigate to a YAML line.
	const sourceFile=/\.(?:toml|m?js|cjs|ya?ml|json|txt|css|ts)$/iu.test(file);
	if(!detail && !line && !sourceFile && entry instanceof TFile){
		const leaf=plugin.app.workspace.getLeaf('tab');
		await leaf.openFile(entry);
		closeReport();
		await plugin.app.workspace.revealLeaf(leaf);
		return;
	}
	let text:string;
	try {
		const bytes=await readRelative(plugin.disk.root,path);
		if(bytes.includes(0))throw new Error('binary');
		text=decode(bytes);
	} catch {
		throw new Error(tr('无法读取当前文件的源码，请确认文件仍存在且为可读的 UTF-8 文本（最多 2 MiB）。',
			'Could not read the source. Check that the file still exists and is readable UTF-8 text (up to 2 MiB).')+' · '+file);
	}
	if(!origin.isConnected)return;
	const target=detail ? baseExpressionLine(text,detail) : line;
	const message=detail && !target ? tr('当前源码中无法唯一定位报告中的表达式。','The reported expression has no unique match in the current source.') : undefined;
	new SourceLocationDialog(plugin,file,text,target,origin,message).open();
}
