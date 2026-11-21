import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import { structuredPatch } from 'diff';
import { renderDiff } from './diff-table.ts';
import { revealSourceTab } from './source-tabs.ts';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { previewVersion } from '../git/versions.ts';
import { fileComparison, changeIndexHunk } from '../git/index-actions.ts';
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
interface DiffTarget { id:string; file:string; staged:boolean; commit?:string; parent?:string }
function isTarget(value:unknown): value is DiffTarget {
	return !!value && typeof value==='object' && 'id' in value && typeof value.id==='string'
		&& 'file' in value && typeof value.file==='string' && 'staged' in value && typeof value.staged==='boolean'
		&& (!('commit' in value) || typeof value.commit==='string')
		&& (!('parent' in value) || typeof value.parent==='string');
}

export function registerSourceDiff(plugin:KnowledgeBaseManager) {
	plugin.registerView(diffType,leaf=>new SourceDiff(leaf,plugin));
	registerSourceHistory(plugin);
}

export async function showDiff(plugin:KnowledgeBaseManager,target:DiffTarget) {
	await revealSourceTab(plugin,diffType,{...target});
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
		const sameTarget=isTarget(value) && this.target?.id===value.id && this.target.file===value.file
			&& this.target.staged===value.staged && this.target.commit===value.commit && this.target.parent===value.parent;
		const initialRows=sameTarget ? this.contentEl.querySelector('tbody')?.rows.length ?? 0 : 0;
		const scrollTop=sameTarget ? this.contentEl.scrollTop : 0;
		this.contentEl.empty();
		const el=this.contentEl.createDiv({cls:'kb-diff-view'});
		if (!isTarget(value)) return;
		this.target=value;
		const p=this.plugin;
		try {
			assertGitEnabled(p);
			const lib=(await discover(p.disk,p.config)).find(l=>l.identity?.id===value.id && !l.duplicate && !l.problem);
			if (!lib) throw new Error(p.t('无法定位知识库','Could not locate the library'));
			const dir=await p.disk.path(lib.location);
			const snapshot=value.commit ? await committedComparison(dir,value.commit,value.file,value.parent) : undefined;
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
