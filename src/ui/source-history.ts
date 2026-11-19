import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { history } from '../git/versions.ts';
import { displayAuthor } from '../git/authorship.ts';
import { commitFiles } from '../git/index-history.ts';
import { showDiff } from './source-diff.ts';
import { assertGitEnabled } from './device.ts';

export const historyType='knowledge-base-manager-history';
export function registerSourceHistory(plugin:KnowledgeBaseManager) {
	plugin.registerView(historyType,leaf=>new SourceHistory(leaf,plugin));
}
export async function showSourceHistory(plugin:KnowledgeBaseManager,id:string) {
	const leaf=plugin.app.workspace.getLeaf('tab');
	await leaf.setViewState({type:historyType,state:{id},active:true});
	await plugin.app.workspace.revealLeaf(leaf);
}
class SourceHistory extends ItemView {
	private id?:string;
	private plugin:KnowledgeBaseManager;
	constructor(leaf:WorkspaceLeaf,plugin:KnowledgeBaseManager){super(leaf);this.plugin=plugin;}
	getViewType(){return historyType;}
	getIcon(){return 'history';}
	getDisplayText(){return this.plugin.t('知识库历史','Library history');}
	getState(){return {id:this.id};}
	async setState(state:unknown,result:ViewStateResult){
		await super.setState(state,result);
		const plugin=this.plugin,t=plugin.t;
		this.contentEl.empty();
		if(!state || typeof state!=='object' || !('id' in state) || typeof state.id!=='string')return;
		const id=this.id=state.id;
		const el=this.contentEl.createDiv({cls:'kb-git-history'});
		const onError=(error:unknown)=>{new Notice(String(error));};
		try{
			assertGitEnabled(plugin);
			const lib=(await discover(plugin.disk,plugin.config)).find(l=>l.identity?.id===id && !l.duplicate && !l.problem);
			if(!lib)throw new Error(t('无法定位知识库','Could not locate the library'));
			el.createEl('h3',{text:lib.location});
			const dir=await plugin.disk.path(lib.location);
			const pref=plugin.preferences(id);
			const list=el.createDiv();
			const more=el.createEl('button',{text:t('下一页','Next page')});
			let cursor:string|undefined;
			async function page(){
				more.disabled=true;
				try{
					assertGitEnabled(plugin);
					await recheck(plugin.disk,plugin.config,lib!);
					const data=await history(dir,cursor);
					for(const {oid,commit} of data.entries){
						const row=list.createEl('details');
						const [subject,...body]=commit.message.trim().split('\n');
						row.createEl('summary',{text:oid.slice(0,10)+' · '+(subject||t('无提交说明','No commit message'))});
						const details=[displayAuthor(commit.author.name,pref.historyAuthor),pref.historyDate && new Date(commit.author.timestamp*1000).toLocaleString()].filter(Boolean);
						if(details.length)row.createEl('p',{cls:'kb-commit-meta',text:details.join(' · ')});
						const description=body.join('\n').trim();
						if(description)row.createEl('p',{cls:'kb-commit-body',text:description});
						let loaded=false;
						row.ontoggle=()=>{if(row.open && !loaded){
							loaded=true;
							void (async()=>{
								assertGitEnabled(plugin);
								await recheck(plugin.disk,plugin.config,lib!);
								const {files}=await commitFiles(dir,oid);
								for(const {file} of files){
									const btn=row.createDiv().createEl('button',{text:file});
									btn.onclick=()=>{void showDiff(plugin,{id,file,staged:false,commit:oid}).catch(onError);};
								}
							})().catch(error=>{loaded=false;onError(error);});
						}};
					}
					cursor=data.next;
					more.hidden=!cursor;
					if(!data.entries.length)list.createEl('p',{text:t('还没有提交','No commits yet')});
				}finally{more.disabled=false;}
			}
			more.onclick=()=>{void page().catch(onError);};
			await page();
		}catch(error){el.createEl('p',{cls:'kb-git-error',text:String(error)});}
	}
}
