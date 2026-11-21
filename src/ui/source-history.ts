import { ItemView, Menu, Notice, Scope, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { discover } from '../kb/catalog.ts';
import { displayAuthor } from '../git/authorship.ts';
import { GraphHistory, historyTips, historyWorktree, snapshotHistory } from '../git/history-graph.ts';
import type { GraphRef, HistoryScope } from '../git/history-graph.ts';
import { assertGitEnabled } from './device.ts';
import { revealSourceTab } from './source-tabs.ts';
import { drawCommitGraph } from './history-graph-row.ts';
import { historyButton, historyDisplayControl, historyOptions, historyScopeControl, refKind } from './history-controls.ts';
import type { HistoryDisplay } from './history-controls.ts';
import { showHistoryMenu } from './history-actions.ts';
import { HistoryWindow, historyRowHeight } from './history-window.ts';
import { renderHistoryDetail } from './history-detail.ts';
import type { HistoryComparisonControl } from './history-detail.ts';
import { renderHistorySearch } from './history-search.ts';
import type { HistorySearch } from './history-search.ts';

export const historyType='knowledge-base-manager-history';
const batchSize=96;
const worktreeOid='worktree';
const newComparison=():HistoryComparisonControl=>({base:'',parent:'',override:'',reversed:false});

export function registerSourceHistory(plugin:KnowledgeBaseManager) {
	plugin.registerView(historyType,leaf=>new SourceHistory(leaf,plugin));
}
export async function showSourceHistory(plugin:KnowledgeBaseManager,id:string) {
	await revealSourceTab(plugin,historyType,{id});
}

class SourceHistory extends ItemView {
	private id?:string;
	private generation=0;
	private branches:HistoryScope='current';
	private search:HistorySearch={query:'',field:'all'};
	private selected='';
	private comparison=newComparison();
	private searchInput?:HTMLInputElement;
	private dispose?:()=>void;
	private anchor?:()=>{oid?:string;offset:number;scroll:number};

	constructor(leaf:WorkspaceLeaf,private readonly plugin:KnowledgeBaseManager){
		super(leaf);
		const focusSearch=()=>{this.searchInput?.focus();this.searchInput?.select();};
		this.registerDomEvent(this.contentEl,'keydown',event=>{
			if((event.ctrlKey || event.metaKey) && event.key.toLowerCase()==='f'){
				event.preventDefault();event.stopPropagation();focusSearch();
			}
		},true);
		this.scope??=new Scope(plugin.app.scope);
		this.scope.register(['Mod'],'f',()=>{focusSearch();return false;});
	}
	getViewType(){return historyType;}
	getIcon(){return 'git-graph';}
	getDisplayText(){return this.plugin.t('知识库历史','Library history');}
	getState(){return {id:this.id};}
	override onClose(){this.generation++;this.dispose?.();return Promise.resolve();}

	async setState(state:unknown,result:ViewStateResult){
		const generation=++this.generation;
		const previous=this.anchor?.();
		this.dispose?.();
		this.dispose=undefined;this.anchor=undefined;this.searchInput=undefined;
		await super.setState(state,result);
		const live=()=>generation===this.generation;
		if(!live())return;
		this.contentEl.empty();
		if(!state || typeof state!=='object' || !('id' in state) || typeof state.id!=='string')return;
		const restore=this.id===state.id?previous:undefined;
		if(this.id!==state.id){
			this.branches='current';this.search={query:'',field:'all'};this.selected='';this.comparison=newComparison();
		}
		const id=this.id=state.id,plugin=this.plugin,t=plugin.t;
		const el=this.contentEl.createDiv({cls:'kb-git-history'});
		try{
			assertGitEnabled(plugin);
			const lib=(await discover(plugin.disk,plugin.config)).find(l=>l.identity?.id===id && !l.duplicate && !l.problem);
			if(!lib)throw new Error(t('无法定位知识库','Could not locate the library'));
			const dir=await plugin.disk.path(lib.location),snapshot=await snapshotHistory(dir);
			if(!live())return;
			const prefs=plugin.preferences(id);
			const options:HistoryDisplay={graph:true,refs:true,stashes:true,worktree:true,author:prefs.historyAuthor!=='hidden',
				date:prefs.historyDate,sha:true,authorWidth:16,dateWidth:12,shaWidth:10,refPosition:'before',detailLayout:'below',
				...historyOptions(plugin)};
			snapshot.tips=historyTips(snapshot,this.branches,options.stashes);
			const workLabel=t('未提交的更改','Uncommitted changes');
			const worktree=options.worktree && !snapshot.detached?await historyWorktree(dir).catch((error:unknown)=>{
				if(live())new Notice(String(error));return undefined;
			}):undefined;
			if(!live())return;
			const graph=new GraphHistory(dir,snapshot,!!worktree);
			const virtual=graph.workingRow?1:0;
			const formatter=new Intl.DateTimeFormat();
			const date=(timestamp:number)=>formatter.format(timestamp*1000);
			const report=(error:unknown)=>{if(live())new Notice(String(error));};
			const reload=()=>{void this.setState({id},{history:false});};
			const changeScope=(scope:HistoryScope)=>{
				this.branches=scope;this.anchor=undefined;reload();
			};
			el.createEl('h3',{text:lib.location});
			const bar=el.createDiv({cls:'kb-history-toolbar'});
			historyScopeControl(bar,plugin,snapshot,this.branches,changeScope);
			historyButton(bar,t('刷新历史','Refresh history'),'refresh-cw').onclick=reload;
			const head=historyButton(bar,t('转到 HEAD','Go to HEAD'),'locate-fixed');
			head.disabled=!snapshot.head;
			historyDisplayControl(bar,plugin,options,reload);
			const searchBar=el.createDiv({cls:'kb-history-toolbar'});
			const panels=el.createDiv({cls:'kb-history-panels'});
			panels.toggleClass('kb-history-panels-side',options.detailLayout==='side');
			const list=panels.createDiv({cls:'kb-history-table',attr:{'aria-label':t('提交历史','Commit history'),role:'group',tabindex:'-1'}});
			list.dataset.scope=typeof this.branches==='string'?this.branches:'custom';
			list.setCssProps({'--kb-history-author-width':options.authorWidth+'ch',
				'--kb-history-date-width':options.dateWidth+'ch','--kb-history-sha-width':options.shaWidth+'ch'});
			const detail=panels.createDiv({cls:'kb-history-detail'});
			const empty=list.createEl('p',{text:t('还没有提交','No commits yet')});empty.hidden=true;
			const rowAt=(index:number)=>virtual && index===0?graph.workingRow:graph.rows[index-virtual];
			const indexOf=(oid:string)=>oid===worktreeOid && virtual?0:(graph.indices.get(oid)??-1)+virtual;
			const present=(oid:string)=>oid===worktreeOid?!!virtual:graph.indices.has(oid);
			let loaded=0,detailRequest=0,pendingJump=0,paging=false;
			const load=async(count:number)=>{
				await graph.load(Math.max(batchSize,count-virtual),live);
				if(!live())return;
				loaded=Math.max(loaded,Math.min(count,graph.rows.length+virtual));
				window.update(loaded,Math.max(1,graph.width));
				empty.hidden=loaded>0;
			};
			const paintDetail=async()=>{
				const index=indexOf(this.selected),row=present(this.selected)?rowAt(index):undefined;
				const request=++detailRequest;
				window.mark(row?index:-1);
				detail.empty();
				if(!row)return;
				const {commit}=row;
				const children=[...(graph.children.get(commit.oid)??[])];
				if(graph.workingRow?.commit.parents.includes(commit.oid))children.unshift(worktreeOid);
				await renderHistoryDetail(detail,{plugin,lib,dir,commit,refs:snapshot.labels.get(commit.oid)??[],head:snapshot.head,
					children,worktree:!snapshot.detached,control:this.comparison,active:()=>live() && request===detailRequest,
					repaint:()=>{void paintDetail().catch(report);},jump:oid=>{void jump(oid,true).catch(report);},
					menu:(anchor,ref)=>showMenu(commit.oid,{anchor,ref})});
			};
			const pick=(oid:string,compare=false)=>{
				if(this.selected!==oid){
					this.comparison.parent='';this.comparison.override='';this.comparison.reversed=false;
					if(compare)this.comparison.base=this.selected || oid;
					this.selected=oid;
				}
				void paintDetail().catch(report);
			};
			const locate=async(oid:string,active=live)=>{
				while(active() && !present(oid) && !graph.complete)await graph.load(graph.rows.length+800,active);
				return active() && present(oid)?indexOf(oid):-1;
			};
			const jump=async(oid:string,focus=false)=>{
				const request=++pendingJump,valid=()=>live() && request===pendingJump;
				const index=await locate(oid,valid);
				if(index<0 || !valid())return;
				if(index>=loaded)await load(index+batchSize);
				if(!valid())return;
				pick(oid);
				window.reveal(index,focus);
			};
			const showMenu=(oid:string,trigger:{anchor?:HTMLElement;event?:MouseEvent;ref?:GraphRef})=>{
				if(!live())return;
				const commit=present(oid) && oid!==worktreeOid?rowAt(indexOf(oid))?.commit:undefined;
				const origin=this.selected && this.selected!==oid?this.selected:snapshot.head!==oid?snapshot.head:'';
				showHistoryMenu({plugin,lib,dir,commit,detached:snapshot.detached,...trigger,refresh:reload,
					selectBase:base=>{
						if(!live())return;
						this.comparison.base=base;this.comparison.override='';this.comparison.reversed=false;
						void jump(base).catch(report);
					},
					openComparison:origin && present(origin)?target=>{
						if(!live() || origin===target)return;
						pick(target);this.comparison.base=origin;void paintDetail().catch(report);
					}:undefined});
			};
			const expandRefs=(button:HTMLElement,oid:string,refs:GraphRef[])=>{
				const menu=new Menu();
				for(const ref of refs)menu.addItem(item=>item.setTitle(refKind(ref.kind,t)+' · '+ref.name)
					.onClick(()=>showMenu(oid,{anchor:button,ref})));
				const rect=button.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.bottom});
			};
			const createRow=(index:number)=>{
				const row=rowAt(index)!;
				const {commit}=row,oid=commit.oid,working=oid===worktreeOid;
				const refs=snapshot.labels.get(oid)??[];
				const title=working?workLabel:commit.message.split('\n')[0]||t('无提交说明','No commit message');
				const button=createEl('button',{cls:'kb-history-row',attr:{type:'button','data-oid':oid}});
				const node=working?'worktree':oid===snapshot.head?'head':refs.some(ref=>ref.kind==='stash')?'stash':
					commit.parents.length>1?'merge':'commit';
				const tooltip=working?workLabel:[title,oid,commit.author,date(commit.timestamp),...refs.map(ref=>ref.name)].join('\n');
				if(options.graph)drawCommitGraph(button,row,tooltip,node);
				const labels=()=>{
					if(!options.refs || !refs.length)return;
					const group=button.createSpan({cls:'kb-history-labels'});
					for(const [i,ref] of refs.slice(0,2).entries())group.createSpan({text:ref.name,cls:['kb-history-ref','kb-history-ref-'+ref.kind],
						attr:{'data-ref-index':String(i),title:refKind(ref.kind,t)+' · '+ref.name}});
					if(refs.length>2)group.createSpan({text:'+'+(refs.length-2),cls:['kb-history-ref','kb-history-ref-more'],
						attr:{title:refs.map(ref=>ref.name).join('\n'),'data-more-refs':'true'}});
				};
				if(options.refPosition==='before')labels();
				button.createSpan({cls:'kb-history-subject',text:title,attr:{title:tooltip}});
				if(options.refPosition==='after')labels();
				if(working && worktree){
					button.createSpan({cls:'kb-commit-meta',text:t('暂存','Staged')+' '+worktree.staged+' · '+t('未暂存','Unstaged')+' '+worktree.unstaged});
				}else{
					if(options.author)button.createSpan({cls:['kb-commit-meta','kb-history-author'],
						text:displayAuthor(commit.author,prefs.historyAuthor==='hidden'?'full':prefs.historyAuthor)});
					if(options.date)button.createSpan({cls:['kb-commit-meta','kb-history-date'],text:date(commit.timestamp)});
					if(options.sha)button.createEl('code',{cls:'kb-history-sha',text:oid.slice(0,10)});
				}
				button.onclick=event=>{
					if(event.target instanceof Element && event.target.closest('[data-more-refs]')){expandRefs(button,oid,refs);return;}
					pendingJump++;pick(oid,event.ctrlKey||event.metaKey);
				};
				button.oncontextmenu=event=>{
					event.preventDefault();event.stopPropagation();
					const target=event.target instanceof Element?event.target.closest<HTMLElement>('[data-ref-index]'):null;
					showMenu(oid,{event,ref:target?refs[Number(target.dataset.refIndex)]:undefined});
				};
				button.onkeydown=event=>{
					const children=graph.children.get(oid)??[];
					const sameLaneChild=children.find(child=>rowAt(indexOf(child))?.color===row.color);
					const sameLaneParent=row.parents.findIndex(rail=>rail.color===row.color);
					const keys:Record<string,()=>void>={
						ArrowUp:()=>{const other=rowAt(index-1);if(other)void jump(other.commit.oid,true).catch(report);},
						ArrowDown:()=>{void (async()=>{if(index+1>=loaded)await load(loaded+batchSize);
							const other=rowAt(index+1);if(other)await jump(other.commit.oid,true);})().catch(report);},
						ArrowLeft:()=>{const parent=commit.parents[Math.max(0,sameLaneParent)];if(parent)void jump(parent,true).catch(report);},
						ArrowRight:()=>{const child=graph.workingRow?.commit.parents.includes(oid)?worktreeOid:sameLaneChild??children[0];
							if(child)void jump(child,true).catch(report);},
						Home:()=>{const first=rowAt(0);if(first)void jump(first.commit.oid,true).catch(report);},
						ContextMenu:()=>showMenu(oid,{anchor:button}),
					};
					const action=event.shiftKey && event.key==='F10'?keys.ContextMenu:event.ctrlKey || event.metaKey || event.altKey?
						undefined:keys[event.key];
					if(action){event.preventDefault();event.stopPropagation();action();}
				};
				return button;
			};
			const window=new HistoryWindow(list,createRow,()=>{
				if(!live() || paging || (graph.complete && loaded>=graph.rows.length+virtual))return;
				paging=true;void load(loaded+batchSize).catch(report).finally(()=>{paging=false;});
			});
			const search=renderHistorySearch(searchBar,graph,t,this.search,prefs.historyAuthor,date,live,()=>this.selected,
				oid=>{void jump(oid).catch(report);},()=>window.focusVisible(),report);
			this.searchInput=search.search;
			this.dispose=()=>{window.destroy();search.close();};
			this.anchor=()=>{
				const index=Math.floor(list.scrollTop/historyRowHeight);
				return {oid:rowAt(index)?.commit.oid,offset:list.scrollTop-index*historyRowHeight,scroll:list.scrollTop};
			};
			head.onclick=()=>{void (async()=>{
				if(typeof this.branches==='string' || await locate(snapshot.head)>=0)await jump(snapshot.head);
				else if(live()){
					this.branches='current';this.selected=snapshot.head;this.comparison=newComparison();this.anchor=undefined;reload();
				}
			})().catch(report);};
			const selected=this.selected?await locate(this.selected):-1;
			const anchor=restore?.oid?await locate(restore.oid):-1;
			if(!live())return;
			if(selected<0){this.selected='';this.comparison.parent='';}
			await load(Math.max(selected+1,anchor+batchSize,batchSize));
			if(!live())return;
			if(this.selected)void paintDetail().catch(report);
			if(restore)list.scrollTop=anchor>=0?anchor*historyRowHeight+restore.offset:restore.scroll;
			else if(selected>=0)window.reveal(selected);
			search.restore();
		}catch(error){if(live())el.createEl('p',{cls:'kb-git-error',text:String(error),attr:{role:'alert'}});}
	}
}
