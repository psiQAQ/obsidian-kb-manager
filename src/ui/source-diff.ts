import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import { createTwoFilesPatch, diffLines } from 'diff';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { previewVersion } from '../git/versions.ts';
import { fileComparison, changeIndexHunk, textHunks } from '../git/index-actions.ts';
import { committedComparison } from '../git/index-history.ts';
import { historyType, registerSourceHistory } from './source-history.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled, pluginNotice } from './device.ts';

const diffType='knowledge-base-manager-file-diff';
export async function refreshSourceTabs(plugin:KnowledgeBaseManager){
	for(const type of [diffType,historyType])for(const leaf of plugin.app.workspace.getLeavesOfType(type)){
		if(leaf.view.getViewType()!==type)continue;
		await leaf.view.setState(leaf.view.getState(),{history:false}).catch(error=>pluginNotice(plugin,'error',String(error)));
	}
}
interface DiffTarget { id:string; file:string; staged:boolean; commit?:string }
function isTarget(value:unknown): value is DiffTarget {
	return !!value && typeof value==='object' && 'id' in value && typeof value.id==='string'
		&& 'file' in value && typeof value.file==='string' && 'staged' in value && typeof value.staged==='boolean'
		&& (!('commit' in value) || typeof value.commit==='string');
}

export function registerSourceDiff(plugin:KnowledgeBaseManager) {
	plugin.registerView(diffType,leaf=>new SourceDiff(leaf,plugin));
	registerSourceHistory(plugin);
}

export async function showDiff(plugin:KnowledgeBaseManager,target:DiffTarget) {
	const leaf=plugin.app.workspace.getLeaf('tab');
	await leaf.setViewState({type:diffType,state:{...target},active:true});
	await plugin.app.workspace.revealLeaf(leaf);
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
		this.contentEl.empty();
		const el=this.contentEl.createDiv();
		if (!isTarget(value)) return;
		this.target=value;
		const p=this.plugin;
		try {
			assertGitEnabled(p);
			const lib=(await discover(p.disk,p.config)).find(l=>l.identity?.id===value.id && !l.duplicate && !l.problem);
			if (!lib) throw new Error(p.t('无法定位知识库','Could not locate the library'));
			const dir=await p.disk.path(lib.location);
			const snapshot=value.commit ? await committedComparison(dir,value.commit,value.file) : undefined;
			const preview=snapshot ? undefined : await previewVersion(dir);
			const workBytes=!value.staged && preview?.changes.find(c=>c.file===value.file)?.workBytes;
			if(workBytes && workBytes>2*1024*1024){
				el.createEl('h3',{text:lib.location+' / '+value.file});
				el.createEl('p',{text:p.t('工作区文件过大，跳过文本差异','Working file exceeds the text diff limit')+' · '+workBytes+' B'});
				return;
			}
			const {before,after}=snapshot ?? await fileComparison(dir,preview!,value.file,value.staged);
			const left=snapshot ? snapshot.parent?.slice(0,10) ?? '∅' : value.staged?'HEAD':p.t('暂存区','Index');
			const right=value.commit?.slice(0,10) ?? (value.staged?p.t('暂存区','Index'):p.t('工作区','Working tree'));
			el.createEl('h3',{text:lib.location+' / '+value.file});
			el.createEl('p',{text:left+' → '+right});
			const bytes=(before?.length ?? 0)+(after?.length ?? 0);
			if(before?.includes(0) || after?.includes(0) || bytes>2*1024*1024) {
				el.createEl('p',{text:p.t('二进制或大文件','Binary or large file')+' · '+(before?.length ?? 0)+' → '+(after?.length ?? 0)+' B'});
				return;
			}
			const decode=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
			let a:string,b:string;
			try{a=decode.decode(before);b=decode.decode(after);}
			catch{
				el.createEl('p',{text:p.t('无法按 UTF-8 显示的文件','Non-UTF-8 file')+' · '+(before?.length ?? 0)+' → '+(after?.length ?? 0)+' B'});
				return;
			}
			const pref=p.preferences(value.id);
			if(before && after && preview && pref.hunkCommands && !lib.identity?.archived){
				const hunks=textHunks(before,after,pref.diffTimeout).patch.hunks;
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
			if(pref.diffStyle==='split') {
				const changes=diffLines(a,b,{timeout:pref.diffTimeout});
				if (!changes) throw new Error(p.t('差异计算超时','Diff computation timed out'));
				const table=el.createEl('table');
				const header=table.createEl('tr');
				header.createEl('th',{text:left});header.createEl('th',{text:right});
				for(const part of changes){
					const row=table.createEl('tr');
					row.createEl('td').createEl('pre',{text:part.added?'':part.value});
					row.createEl('td').createEl('pre',{text:part.removed?'':part.value});
				}
			} else {
				const patch=createTwoFilesPatch(left,right,a,b,undefined,undefined,{timeout:pref.diffTimeout});
				el.createEl('pre',{text:patch ?? p.t('差异计算超时','Diff computation timed out')});
			}
		} catch(error){el.createEl('p',{text:String(error)});}
	}
}
