import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import { structuredPatch } from 'diff';
import { renderDiff } from './diff-table.ts';
import { isHistoryComparison, revealSourceTab, sourceTabKey } from './source-tabs.ts';
import type { HistoryFileComparison } from './source-tabs.ts';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { previewVersion } from '../git/versions.ts';
import { fileComparison, changeIndexHunk } from '../git/index-actions.ts';
import { committedComparison, compareHistoryFile, historyTextLimit, readHistorySnapshot } from '../git/index-history.ts';
import type { HistorySide } from '../git/index-history.ts';
import { historyType, registerSourceHistory, showSourceHistory } from './source-history.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled, pluginNotice } from './device.ts';

const diffType='knowledge-base-manager-file-diff';
const snapshotType='knowledge-base-manager-file-snapshot';
export async function refreshSourceTabs(plugin:KnowledgeBaseManager){
	for(const type of [diffType,historyType,snapshotType])for(const leaf of plugin.app.workspace.getLeavesOfType(type)){
		if(leaf.view.getViewType()!==type)continue;
		await leaf.view.setState(leaf.view.getState(),{history:false}).catch(error=>pluginNotice(plugin,'error',String(error)));
	}
}
interface DiffTarget { id:string; file:string; staged:boolean; commit?:string; parent?:string; comparison?:HistoryFileComparison }
interface SnapshotTarget {id:string;file:string;commit:string}

function isSnapshot(value:unknown):value is SnapshotTarget {
	return !!value && typeof value==='object' && 'id' in value && typeof value.id==='string'
		&& 'file' in value && typeof value.file==='string' && 'commit' in value && typeof value.commit==='string';
}

function isTarget(value:unknown): value is DiffTarget {
	return !!value && typeof value==='object' && 'id' in value && typeof value.id==='string'
		&& 'file' in value && typeof value.file==='string' && 'staged' in value && typeof value.staged==='boolean'
		&& (!('commit' in value) || typeof value.commit==='string')
		&& (!('parent' in value) || typeof value.parent==='string')
		&& (!('comparison' in value) || isHistoryComparison(value.comparison));
}

export function registerSourceDiff(plugin:KnowledgeBaseManager) {
	plugin.registerView(diffType,leaf=>new SourceDiff(leaf,plugin));
	plugin.registerView(snapshotType,leaf=>new SourceSnapshot(leaf,plugin));
	registerSourceHistory(plugin);
}

export async function showDiff(plugin:KnowledgeBaseManager,target:DiffTarget) {
	await revealSourceTab(plugin,diffType,{...target});
}

export async function showHistorySnapshot(plugin:KnowledgeBaseManager,target:SnapshotTarget) {
	await revealSourceTab(plugin,snapshotType,target);
}

export function historySideLabel(plugin:KnowledgeBaseManager,side:HistorySide) {
	return side.kind==='commit'?side.oid.slice(0,10):side.kind==='empty'
		?plugin.t('空树','Empty tree'):plugin.t('工作区','Working tree');
}

async function locateLibrary(plugin:KnowledgeBaseManager,id:string) {
	assertGitEnabled(plugin);
	const lib=(await discover(plugin.disk,plugin.config)).find(l=>l.identity?.id===id && !l.duplicate && !l.problem);
	if(!lib)throw new Error(plugin.t('无法定位知识库','Could not locate the library'));
	await recheck(plugin.disk,plugin.config,lib);
	return lib;
}

const decodeText=(bytes?:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);

function addReturnToGraph(el:HTMLElement,plugin:KnowledgeBaseManager,id:string) {
	const back=el.createEl('button',{text:plugin.t('返回历史图','Back to graph'),attr:{type:'button'}});
	back.onclick=()=>{void showSourceHistory(plugin,id).catch(error=>pluginNotice(plugin,'error',String(error),id));};
}

class SourceDiff extends ItemView {
	private target?:DiffTarget;
	private plugin:KnowledgeBaseManager;
	constructor(leaf:WorkspaceLeaf,plugin:KnowledgeBaseManager){super(leaf);this.plugin=plugin;}
	getViewType(){return diffType;}
	getIcon(){return 'git-compare';}
	getDisplayText(){return this.target?.file ?? this.plugin.t('知识库差异','Library diff');}
	getState(){return {...this.target};}
	async setState(value:unknown,result:ViewStateResult) {
		await super.setState(value,result);
		const sameTarget=isTarget(value) && this.target && sourceTabKey(diffType,this.target)===sourceTabKey(diffType,value);
		const initialRows=sameTarget ? this.contentEl.querySelector('tbody')?.rows.length ?? 0 : 0;
		const scrollTop=sameTarget ? this.contentEl.scrollTop : 0;
		this.contentEl.empty();
		const el=this.contentEl.createDiv({cls:'kb-diff-view'});
		if (!isTarget(value)) return;
		this.target=value;
		const p=this.plugin;
		try {
			const lib=await locateLibrary(p,value.id);
			const dir=await p.disk.path(lib.location);
			const pair=value.comparison;
			if(pair || value.commit)addReturnToGraph(el,p,value.id);
			const selected=pair?await compareHistoryFile(dir,pair.before,pair.after,value.file,pair.oldFile):undefined;
			const snapshot=value.commit?await committedComparison(dir,value.commit,value.file,value.parent):undefined;
			const preview=selected || snapshot?undefined:await previewVersion(dir);
			const workBytes=!value.staged && preview?.changes.find(c=>c.file===value.file)?.workBytes;
			const displayPath=pair?.oldFile && pair.oldFile!==value.file?pair.oldFile+' → '+value.file:value.file;
			el.createEl('h3',{text:lib.location+' / '+displayPath});
			if(workBytes && workBytes>historyTextLimit){
				el.createEl('p',{text:p.t('工作区文件过大，跳过文本差异','Working file exceeds the text diff limit')+' · '+workBytes+' B'});
				return;
			}
			const {before,after}=selected?{before:selected.before?.bytes,after:selected.after?.bytes}
				:snapshot??await fileComparison(dir,preview!,value.file,value.staged);
			const left=pair?historySideLabel(p,pair.before):snapshot?snapshot.parent?.slice(0,10)??p.t('空树','Empty tree'):value.staged?'HEAD':p.t('暂存区','Index');
			const right=pair?historySideLabel(p,pair.after):value.commit?.slice(0,10)??(value.staged?p.t('暂存区','Index'):p.t('工作区','Working tree'));
			el.createEl('p',{text:left+' → '+right});
			const beforeSize=selected?.before?.size??snapshot?.beforeSize??before?.length??0;
			const afterSize=selected?.after?.size??snapshot?.afterSize??after?.length??0;
			const sizes=' · '+beforeSize+' → '+afterSize+' B';
			if(before?.includes(0) || after?.includes(0) || beforeSize+afterSize>historyTextLimit) {
				el.createEl('p',{text:p.t('二进制或大文件','Binary or large file')+sizes});
				return;
			}
			let a:string,b:string;
			try{a=decodeText(before);b=decodeText(after);}
			catch{
				el.createEl('p',{text:p.t('无法按 UTF-8 显示的文件','Non-UTF-8 file')+sizes});
				return;
			}
			const pref=p.preferences(value.id);
			const patch=structuredPatch(left,right,a,b,undefined,undefined,{context:3,timeout:pref.diffTimeout});
			if(!patch)throw new Error(p.t('差异计算超时','Diff computation timed out'));
			if(!patch.hunks.length){
				const message=!before ? p.t('新增空文件','Added empty file') : !after ? p.t('已删除空文件','Deleted empty file') : p.t('文本内容相同','Text contents are identical');
				el.createEl('p',{text:message});
				return;
			}
			if(before && after && preview && pref.hunkCommands && !lib.identity?.archived){
				const hunks=patch.hunks;
				const controls=el.createEl('details');
				controls.createEl('summary',{text:p.t('差异块','Hunks')+' ('+hunks.length+')'});
				for(const [i,hunk] of hunks.entries()){
					const label=value.staged?p.t('取消暂存此块','Unstage hunk'):p.t('暂存此块','Stage hunk');
					const btn=controls.createEl('button',{text:label+' · '+hunk.oldStart+' → '+hunk.newStart});
					btn.onclick=()=>{
						const modal=new Dialog(p.app,label);
						modal.lines([lib.location,value.file]);
						modal.contentEl.createEl('pre',{text:hunk.lines.join('\n')});
						modal.action(label,async()=>{
							await p.exclusiveGit(lib.location,async()=>{
								await recheck(p.disk,p.config,lib);
								await changeIndexHunk(dir,preview,value.staged?'unstage':'stage',value.file,i);
							});
							modal.close();
							await p.refresh();
						});modal.open();
					};
				}
			}
			renderDiff(el,patch.hunks,pref.diffStyle==='split',left,right,initialRows);
			if(el.parentElement===this.contentEl)this.contentEl.scrollTop=scrollTop;
		} catch(error){el.createEl('p',{cls:'kb-git-error',text:String(error)});}
	}
}

class SourceSnapshot extends ItemView {
	private target?:SnapshotTarget;
	constructor(leaf:WorkspaceLeaf,private plugin:KnowledgeBaseManager){super(leaf);}
	getViewType(){return snapshotType;}
	getIcon(){return 'file-lock';}
	getDisplayText(){return this.target?this.target.file+' · '+this.target.commit.slice(0,10):this.plugin.t('历史版本','Historical version');}
	getState(){return {...this.target};}
	async setState(value:unknown,result:ViewStateResult){
		await super.setState(value,result);
		if(!isSnapshot(value))return;
		this.target=value;
		const p=this.plugin;
		this.contentEl.empty();
		const el=this.contentEl.createDiv({cls:'kb-diff-view kb-history-snapshot'});
		try{
			const lib=await locateLibrary(p,value.id);
			const dir=await p.disk.path(lib.location);
			addReturnToGraph(el,p,value.id);
			const {bytes,size}=await readHistorySnapshot(dir,value.commit,value.file);
			el.createEl('h3',{text:lib.location+' / '+value.file});
			el.createEl('p',{text:p.t('只读历史版本','Read-only historical version')+' · '+value.commit});
			if(!bytes || bytes.includes(0)){
				el.createEl('p',{text:p.t('二进制或大文件','Binary or large file')+' · '+size+' B'});
				return;
			}
			let text:string;
			try{text=decodeText(bytes);}
			catch{el.createEl('p',{text:p.t('无法按 UTF-8 显示的文件','Non-UTF-8 file')+' · '+size+' B'});return;}
			if(text)el.createEl('pre',{text});
			else el.createEl('p',{text:p.t('空文件','Empty file')});
		}catch(error){el.createEl('p',{cls:'kb-git-error',text:String(error)});}
	}
}
