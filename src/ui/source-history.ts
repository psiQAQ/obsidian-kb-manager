import { ItemView, Notice, Scope, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import { displayAuthor } from '../git/authorship.ts';
import { commitFiles } from '../git/index-history.ts';
import { GraphHistory, snapshotHistory } from '../git/history-graph.ts';
import type { GraphCommit } from '../git/history-graph.ts';
import { showDiff } from './source-diff.ts';
import { assertGitEnabled } from './device.ts';
import { revealSourceTab } from './source-tabs.ts';
import { drawCommitGraph } from './history-graph-row.ts';

export const historyType='knowledge-base-manager-history';
const batchSize=20;
export function registerSourceHistory(plugin:KnowledgeBaseManager) {
	plugin.registerView(historyType,leaf=>new SourceHistory(leaf,plugin));
}
export async function showSourceHistory(plugin:KnowledgeBaseManager,id:string) {
	await revealSourceTab(plugin,historyType,{id});
}

class SourceHistory extends ItemView {
	private id?:string;
	private plugin:KnowledgeBaseManager;
	private generation=0;
	private all=false;
	private query='';
	private tailObserver?:IntersectionObserver;
	private selected='';
	private parent='';
	private searchInput?:HTMLInputElement;

	constructor(leaf:WorkspaceLeaf,plugin:KnowledgeBaseManager){
		super(leaf);this.plugin=plugin;
		this.contentEl.addEventListener('keydown',event=>{
			if((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='f'){
				event.preventDefault();event.stopPropagation();this.searchInput?.focus();this.searchInput?.select();
			}
		},true);
		// Obsidian routes workspace shortcuts through the active leaf's scope.
		this.scope??=new Scope(plugin.app.scope);
		this.scope.register(['Mod'],'f',()=>{this.searchInput?.focus();this.searchInput?.select();return false;});
	}
	getViewType(){return historyType;}
	getIcon(){return 'git-graph';}
	getDisplayText(){return this.plugin.t('知识库历史','Library history');}
	getState(){return {id:this.id};}
	override onClose(){this.generation++;this.tailObserver?.disconnect();return Promise.resolve();}
	async setState(state:unknown,result:ViewStateResult){
		const generation=++this.generation;
		this.tailObserver?.disconnect();
		await super.setState(state,result);
		if(generation!==this.generation)return;
		const previousList=this.contentEl.querySelector<HTMLElement>('.kb-history-table');
		const scroll=previousList?.scrollTop??0;
		const previousRow=previousList && Array.from(previousList.querySelectorAll<HTMLElement>('[data-oid]'))
			.find(row=>row.getBoundingClientRect().bottom>previousList.getBoundingClientRect().top);
		const anchor=previousRow?.dataset.oid;
		const offset=previousRow && previousList?previousRow.getBoundingClientRect().top-previousList.getBoundingClientRect().top:0;
		this.contentEl.empty();
		if(!state || typeof state!=='object' || !('id' in state) || typeof state.id!=='string')return;
		const restore=this.id===state.id && previousList?.dataset.scope===(this.all?'all':'current');
		if(this.id!==state.id){
			this.all=false;this.query='';this.selected='';this.parent='';
		}
		const id=this.id=state.id,plugin=this.plugin,t=plugin.t;
		const el=this.contentEl.createDiv({cls:'kb-git-history'});
		const live=()=>generation===this.generation;
		try{
			assertGitEnabled(plugin);
			const lib=(await discover(plugin.disk,plugin.config)).find(l=>l.identity?.id===id && !l.duplicate && !l.problem);
			if(!lib)throw new Error(t('无法定位知识库','Could not locate the library'));
			const dir=await plugin.disk.path(lib.location);
			const graph=new GraphHistory(dir,await snapshotHistory(dir,this.all));
			if(!live())return;
			const pref=plugin.preferences(id);
			el.createEl('h3',{text:lib.location});
			const bar=el.createDiv({cls:'kb-history-toolbar'});
			const scope=bar.createEl('select',{cls:'kb-history-scope',attr:{'aria-label':t('历史范围','History scope')}});
			scope.createEl('option',{value:'current',text:t('当前分支','Current branch')+' · '+graph.snapshot.branch});
			scope.createEl('option',{value:'all',text:t('所有分支（含远端跟踪分支）','All branches (including remote-tracking branches)')});
			scope.value=this.all?'all':'current';
			scope.onchange=()=>{
				this.all=scope.value==='all';this.selected='';this.parent='';
				void this.setState({id},{history:false});
			};
			const search=this.searchInput=bar.createEl('input',{type:'search',placeholder:t('查找提交 SHA、说明或作者','Find SHA, message or author')});
			search.setAttribute('aria-label',search.placeholder);
			search.value=this.query;
			const find=bar.createDiv({cls:'kb-find-controls'});
			const list=el.createDiv({cls:'kb-history-table',attr:{'aria-label':t('提交历史','Commit history')}});
			list.dataset.scope=scope.value;
			const detail=el.createDiv({cls:'kb-history-detail'});
			let detailRequest=0,searchRequest=0;
			const report=(error:unknown)=>{if(live())new Notice(String(error));};
			const showDetails=async(commit:GraphCommit)=>{
				const request=++detailRequest;
				detail.empty();this.selected=commit.oid;
				for(const button of Array.from(list.querySelectorAll<HTMLElement>('[data-oid]')))
					button.setAttribute('aria-pressed',String(button.dataset.oid===commit.oid));
				detail.createEl('h4',{text:commit.message.split('\n')[0]||t('无提交说明','No commit message')});
				const body=commit.message.split('\n').slice(1).join('\n').trim();
				if(body)detail.createEl('p',{cls:'kb-commit-body',text:body});
				const parent=commit.parents.includes(this.parent)?this.parent:commit.parents[0];
				this.parent=parent??'';
				const sides=detail.createDiv({cls:'kb-history-comparison'});
				if(commit.parents.length>1){
					const choose=sides.createEl('select',{cls:'kb-history-parent',attr:{'aria-label':t('比较父提交','Comparison parent')}});
					for(const [i,oid] of commit.parents.entries())
						choose.createEl('option',{value:oid,text:t('父提交','Parent')+' '+(i+1)+' · '+oid.slice(0,10)});
					choose.value=this.parent;
					choose.onchange=()=>{this.parent=choose.value;void showDetails(commit).catch(report);};
				}else sides.createSpan({text:parent?.slice(0,10)??'∅'});
				sides.createSpan({text:' → '+commit.oid.slice(0,10)});
				await recheck(plugin.disk,plugin.config,lib);
				const {files}=await commitFiles(dir,commit.oid,parent);
				if(!live() || request!==detailRequest)return;
				if(!files.length)detail.createEl('p',{text:t('此比较没有文件变更','No file changes in this comparison')});
				for(const {file,before,after} of files){
					const button=detail.createEl('button',{cls:'kb-history-file',attr:{type:'button'}});
					button.createSpan({text:!before?'A':!after?'D':'M',cls:'kb-history-change'});
					button.createSpan({text:file});
					button.onclick=()=>{void showDiff(plugin,{id,file,staged:false,commit:commit.oid,
						...(parent && parent!==commit.parents[0]?{parent}:{})}).catch(report);};
				}
			};
			let rendered=0,lanes=0;
			const observer=this.tailObserver=new IntersectionObserver(entries=>{
				if(live() && entries.some(entry=>entry.isIntersecting && entry.target===list.lastElementChild))
					void appendThrough(rendered+batchSize).catch(report);
			},{root:list,rootMargin:'0px 0px 96px 0px'});
			const appendThrough=async(count:number,valid=live)=>{
				await graph.load(count+1);
				if(!valid())return;
				const end=Math.min(count,graph.rows.length);
				if(end<=rendered)return;
				observer.disconnect();
				for(const row of graph.rows.slice(rendered,end)){
					const {commit}=row;
					const button=list.createEl('button',{cls:'kb-history-row',attr:{type:'button','data-oid':commit.oid,'aria-pressed':String(commit.oid===this.selected)}});
					drawCommitGraph(button,row);
					lanes=Math.max(lanes,row.width);
					const summary=button.createSpan({cls:'kb-history-subject'});
					for(const name of graph.snapshot.labels.get(commit.oid)??[])summary.createSpan({text:name,cls:'kb-history-ref'});
					summary.createSpan({text:commit.message.split('\n')[0]||t('无提交说明','No commit message')});
					button.createSpan({cls:'kb-commit-meta',text:[displayAuthor(commit.author,pref.historyAuthor),
						pref.historyDate?new Date(commit.timestamp*1000).toLocaleDateString():''].filter(Boolean).join(' · ')});
					button.createEl('code',{text:commit.oid.slice(0,10)});
					button.onclick=()=>{this.parent='';void showDetails(commit).catch(report);};
				}
				rendered=end;
				list.setCssProps({'--kb-history-lanes':String(lanes)});
				if(end<graph.rows.length && list.lastElementChild)observer.observe(list.lastElementChild);
			};
			const findSelection=async(oid:string,valid:()=>boolean)=>{
				let from=0;
				while(valid()){
					for(;from<graph.rows.length;from++)if(graph.rows[from]!.commit.oid===oid)return from;
					if(graph.complete)return -1;
					await graph.load(from+200);
				}
				return -1;
			};
			const runSearch=async(keepSelection=false)=>{
				const request=++searchRequest,query=this.query.trim().toLowerCase();
				const valid=()=>live() && request===searchRequest;
				find.empty();
				if(!query)return;
				const status=find.createSpan({attr:{role:'status'},text:t('查找中…','Searching…')});
				const matches:number[]=[];
				let checked=0;
				while(valid()){
					for(;checked<graph.rows.length;checked++){
						const c=graph.rows[checked]!.commit;
						if([c.oid,c.message,c.author].some(v=>v.toLowerCase().includes(query)))matches.push(checked);
					}
					if(graph.complete)break;
					await graph.load(checked+200);
				}
				if(!valid())return;
				if(!matches.length){status.setText(t('没有匹配的提交','No matching commits'));return;}
				let at=Math.max(0,matches.findIndex(n=>graph.rows[n]!.commit.oid===this.selected));
				let jumpRequest=0;
				const jump=async(step:number)=>{
					const current=++jumpRequest;
					at=(at+step+matches.length)%matches.length;
					const index=matches[at]!,commit=graph.rows[index]!.commit;
					status.setText((at+1)+' / '+matches.length);
					await appendThrough(index+batchSize,valid);
					if(!valid() || current!==jumpRequest)return;
					if(commit.oid!==this.selected)this.parent='';
					await showDetails(commit);
					if(valid() && current===jumpRequest)list.querySelector('[data-oid="'+commit.oid+'"]')?.scrollIntoView({block:'nearest'});
				};
				for(const [label,cls,step] of [[t('上一匹配','Previous match'),'kb-find-prev',-1],[t('下一匹配','Next match'),'kb-find-next',1]] as const){
					const btn=find.createEl('button',{cls,text:label});btn.disabled=matches.length===1;btn.onclick=()=>{void jump(step).catch(report);};
				}
				if(keepSelection){status.setText((at+1)+' / '+matches.length);return;}
				await jump(0);
			};
			search.oninput=()=>{this.query=search.value;void runSearch().catch(report);};
			const selected=this.selected;
			const index=selected?await findSelection(selected,live):-1;
			if(!live())return;
			if(index<0){this.selected='';this.parent='';}
			const anchorIndex=restore && anchor?await findSelection(anchor,live):-1;
			if(!live())return;
			await appendThrough(Math.max(batchSize,index+1,anchorIndex+batchSize));
			if(!live())return;
			if(!rendered)list.createEl('p',{text:t('还没有提交','No commits yet')});
			if(index>=0)await showDetails(graph.rows[index]!.commit);
			if(restore){
				const row=anchor && list.querySelector<HTMLElement>('[data-oid="'+anchor+'"]');
				list.scrollTop=row?list.scrollTop+row.getBoundingClientRect().top-list.getBoundingClientRect().top-offset:scroll;
			}
			if(this.query)await runSearch(index>=0);
		}catch(error){if(live())el.createEl('p',{cls:'kb-git-error',text:String(error)});}
	}
}
