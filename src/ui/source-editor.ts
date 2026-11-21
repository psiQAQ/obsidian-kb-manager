// Per-library adaptation of the hunk navigation and line signs in Obsidian Git.
import { RangeSet, StateEffect, StateField } from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, gutter } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { Editor, TFile } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { changeIndex, changeIndexHunk, editorIndexBase, fileComparison, reverseWorkHunk, textHunks, verifyWorkingFile } from '../git/index-actions.ts';
import { previewVersion } from '../git/versions.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled,gitDisabled,pluginNotice } from './device.ts';
import { registerConflictEditor } from './source-conflicts.ts';
import { hunkLines } from '../git/hunk-lines.ts';
import type { GitPreferences } from '../preferences.ts';

type Hunk=ReturnType<typeof textHunks>['patch']['hunks'][number];
type HunkCommand='next'|'previous'|'preview'|'stage'|'reset';
const commands:Record<HunkCommand,[string,string]>={
	next:['跳到下一差异块','Next hunk'],previous:['跳到上一差异块','Previous hunk'],
	preview:['预览光标处差异块','Preview hunk at cursor'],stage:['暂存光标处差异块','Stage hunk at cursor'],
	reset:['恢复光标处差异块','Reset hunk at cursor'],
};

const normalize=(s:string)=>s.replace(/^\uFEFF/u,'').replace(/\r\n/gu,'\n');
const decode=(bytes:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
async function locate(plugin:KnowledgeBaseManager,path:string){
	return (await discover(plugin.disk,plugin.config)).find(l=>l.identity && !l.duplicate && !l.problem &&
		l.git==='local' && path.startsWith(l.location+'/'));
}

async function act(plugin:KnowledgeBaseManager,action:HunkCommand,editor:Editor,item:TFile){
	assertGitEnabled(plugin);
	const t=plugin.t,lib=await locate(plugin,item.path);
	if(!lib?.identity)throw new Error(t('文件不在可用的知识库中','File is outside an available library'));
	const prefs=plugin.preferences(lib.identity.id);
	if(!prefs.hunkCommands)throw new Error(t('请在本库编辑器设置中启用差异块命令','Enable hunk commands in this library’s editor settings'));
	const dir=await plugin.disk.path(lib.location), file=item.path.slice(lib.location.length+1);
	const preview=await previewVersion(dir);
	const {before,after}=await fileComparison(dir,preview,file,false);
	if(!after)throw new Error(t('工作区中没有此文件','The file is missing from the working tree'));
	const text=decode(after);
	const assertSaved=()=>{
		if(normalize(editor.getValue())!==normalize(text) || item.path!==lib.location+'/'+file){
			throw new Error(t('笔记尚未写入磁盘或路径已变化，请保存后重试','The note is unsaved or moved. Save it and retry.'));
		}
	};
	assertSaved();
	const {patch}=textHunks(before ?? new Uint8Array(),after,prefs.diffTimeout);
	if(!patch.hunks.length)throw new Error(t('当前文件没有差异块','There are no hunks in this file'));
	const cursor=editor.getCursor().line+1;
	const starts=patch.hunks.map(h=>Math.min(editor.lineCount(),hunkLines(h).marks.keys().next().value ?? 1));
	if(action==='next' || action==='previous'){
		const target=action==='next' ? starts.find(n=>n>cursor) ?? starts[0]! : [...starts].reverse().find(n=>n<cursor) ?? starts[starts.length-1]!;
		const pos={line:target-1,ch:0};
		editor.setCursor(pos);editor.scrollIntoView({from:pos,to:pos},true);
		return;
	}
	const index=patch.hunks.findIndex(h=>cursor>=Math.max(1,h.newStart) && cursor<=Math.max(1,h.newStart+h.newLines-1));
	const hunk=patch.hunks[index];
	if(!hunk)throw new Error(t('请将光标放在差异块内','Place the cursor inside a hunk'));
	const label=t(...commands[action]);
	const dialog=new Dialog(plugin.app,label);
	dialog.lines([item.path,preview.branch]);
	dialog.contentEl.createEl('pre',{text:hunk.lines.join('\n')});
	if(action!=='preview' && !lib.identity.archived)dialog.action(label,async()=>{
		await plugin.exclusiveGit(lib.location,async()=>{
			await recheck(plugin.disk,plugin.config,lib);
			assertSaved();
			if(action==='stage'){
				if(before)await changeIndexHunk(dir,preview,'stage',file,index);
				else await changeIndex(dir,preview,'stage',[file]);
			} else {
				const fresh=await fileComparison(dir,preview,file,false);
				await verifyWorkingFile(dir,file);
				const fileChanged=t('文件内容已变化，请重新预览','File contents changed. Reopen the preview.');
				if(!fresh.after)throw new Error(fileChanged);
				const restored=reverseWorkHunk(fresh.before ?? new Uint8Array(),fresh.after,index,prefs.diffTimeout);
				await plugin.app.vault.process(item,current=>{
					assertSaved();
					if(current!==text)throw new Error(fileChanged);
					return restored;
				});
			}
		});
		dialog.close();await plugin.refresh();
	});
	dialog.open();
}

class Sign extends GutterMarker {
	private symbol:string;
	constructor(symbol:string){super();this.symbol=symbol;}
	eq(other:Sign){return this.symbol===other.symbol;}
	toDOM(view:EditorView){return (view.dom.ownerDocument.defaultView ?? window).createSpan({text:this.symbol});}
}
const marks=StateEffect.define<RangeSet<GutterMarker>>();
const state=StateField.define<RangeSet<GutterMarker>>({
	create:()=>RangeSet.empty,
	update:(value,txn)=>{
		for(const effect of txn.effects)if(effect.is(marks))return effect.value;
		return txn.docChanged ? RangeSet.empty : value;
	},
});

const listeners=new WeakMap<KnowledgeBaseManager,Set<()=>void>>();
const commandLabels=new WeakMap<KnowledgeBaseManager,string>();
export function refreshSourceEditors(plugin:KnowledgeBaseManager){
	const language=plugin.t('中','en');
	if(commandLabels.get(plugin)!==language){
		for(const action of Object.keys(commands) as HunkCommand[]){
			const id='hunk-'+action;
			if(commandLabels.has(plugin))plugin.removeCommand(id);
			plugin.addCommand({id,name:plugin.t(...commands[action]),editorCallback:(editor,ctx)=>{
				if(ctx.file)void act(plugin,action,editor,ctx.file).catch(e=>pluginNotice(plugin,'error',String(e)));
			}});
		}
		commandLabels.set(plugin,language);
	}
	for(const update of listeners.get(plugin) ?? [])update();
}

export function registerSourceEditor(plugin:KnowledgeBaseManager){
	const updates=new Set<()=>void>();
	registerConflictEditor(plugin,updates);
	listeners.set(plugin,updates);
	const status=plugin.addStatusBarItem();status.hide();
	refreshSourceEditors(plugin);
	plugin.registerEditorExtension([state,gutter({class:'kb-hunk-gutter',markers:view=>view.state.field(state)}),
		EditorView.baseTheme({'.kb-hunk-gutter':{color:'var(--text-accent)',fontFamily:'var(--font-monospace)'}}),
		ViewPlugin.fromClass(class {
			private timer?:number;
			private version=0;
			private path?:string;
			private base?:Uint8Array;
			private libId?:string;
			private view:EditorView;
			private refresh=()=>{this.path=undefined;this.schedule();};
			constructor(view:EditorView){this.view=view;updates.add(this.refresh);this.schedule();}
			update(update:ViewUpdate){
				if(update.docChanged || update.focusChanged || update.startState.field(editorInfoField,false)?.file?.path!==this.file()?.path)this.schedule();
			}
			private file(){return this.view.state.field(editorInfoField,false)?.file;}
			private schedule(){
				window.clearTimeout(this.timer);
				const version=++this.version;
				this.timer=window.setTimeout(()=>{void this.paint(version).catch(()=>{if(version===this.version)this.display([],false,false);});},350);
			}
			private async paint(version:number){
				const file=this.file();
				if(!file || gitDisabled(plugin))return this.display([],false,false);
				const shared=plugin.preferences();
				if(!shared.hunkSigns && shared.hunkStatusBar==='disabled' && !Object.values(plugin.prefs.libraries).some(p=>p.hunkSigns || (p.hunkStatusBar && p.hunkStatusBar!=='disabled'))){
					this.display([],false,false);return;
				}
				if(this.path!==file.path){
					const lib=await locate(plugin,file.path);
					const pref=plugin.preferences(lib?.identity?.id);
					const base=lib && (pref.hunkSigns || pref.hunkStatusBar!=='disabled')
						? await editorIndexBase(await plugin.disk.path(lib.location),file.path.slice(lib.location.length+1)) : undefined;
					if(version!==this.version)return;
					this.path=file.path;this.base=base;this.libId=lib?.identity?.id;
				}
				const pref=plugin.preferences(this.libId);
				if(!this.base || (!pref.hunkSigns && pref.hunkStatusBar==='disabled'))return this.display([],false,false);
				const encode=new TextEncoder();
				const hunks=textHunks(encode.encode(normalize(decode(this.base))),encode.encode(normalize(this.view.state.doc.toString())),pref.diffTimeout).patch.hunks;
				this.display(hunks,pref.hunkSigns,pref.hunkStatusBar);
			}
			private display(hunks:Hunk[],signs:boolean,mode:GitPreferences['hunkStatusBar']|false){
				const doc=this.view.state.doc;
				const symbols=new Map<number,string>();
				const totals={added:0,changed:0,deleted:0};
				for(const h of hunks){
					const {marks,counts}=hunkLines(h);
					totals.added+=counts.added; totals.changed+=counts.changed; totals.deleted+=counts.deleted;
					if(signs)for(const [line,symbol] of marks)symbols.set(doc.line(Math.min(doc.lines,line)).from,symbol);
				}
				const ranges=Array.from(symbols,([pos,s])=>new Sign(s).range(pos));
				this.view.dispatch({effects:marks.of(RangeSet.of(ranges,true))});
				if(plugin.app.workspace.getActiveFile()?.path===this.file()?.path){
					status.empty();
					if(!mode || mode==='disabled' || !hunks.length){status.hide();return;}
					status.toggleClass('kb-line-counts-colored',mode==='colored');
					status.setAttribute('aria-label',plugin.t('当前笔记新增、修改、删除的行数','Lines added, changed and deleted in the current note'));
					for(const [key,prefix] of [['added','+'],['changed','~'],['deleted','−']] as const){
						if(totals[key])status.createSpan({cls:'kb-lines-'+key,text:prefix+totals[key]+' '});
					}
					status.show();
				}
			}
			destroy(){this.version++;window.clearTimeout(this.timer);updates.delete(this.refresh);}
		})]);
	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change',()=>{status.hide();for(const update of updates)update();}));
}
