import {EditorState} from '@codemirror/state';
import {EditorView, highlightActiveLine, highlightActiveLineGutter, lineNumbers} from '@codemirror/view';
import {TFile, TFolder} from 'obsidian';
import {decode, readRelative} from '../diagnostics/snapshot.ts';
import {tr} from '../i18n.ts';
import type KnowledgeBaseManager from '../main.ts';
import {V3Dialog} from './dialog.ts';

class SourceLocationDialog extends V3Dialog {
	private editor?: EditorView;

	constructor(plugin:KnowledgeBaseManager, private file:string, private source:string, private line:number|undefined, origin:HTMLElement) {
		super(plugin.app,file+(line ? ' · '+tr('第 ','Line ')+line+tr(' 行','') : ''),origin.win);
		this.returnFocusTo(origin);
	}

	onOpen() {
		const doc=EditorState.create({doc:this.source}).doc;
		const target=this.line && this.line<=doc.lines ? doc.line(this.line) : undefined;
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
		if(target)this.editor.dispatch({effects:EditorView.scrollIntoView(target.from,{y:'center'})});
		this.editor.focus();
	}

	override onClose(){
		this.editor?.destroy();
		super.onClose();
	}
}

export async function openDiagnosticLocation(plugin:KnowledgeBaseManager,location:string,file:string,line:number|undefined,
	origin:HTMLElement,closeReport:()=>void) {
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
	if(!line && !sourceFile && entry instanceof TFile){
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
	if(origin.isConnected)new SourceLocationDialog(plugin,file,text,line,origin).open();
}
