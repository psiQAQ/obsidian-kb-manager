import { ItemView, Menu, Notice, Scope, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { displayAuthor } from '../git/authorship.ts';
import { GraphHistory, historyRefKey, historyWorktree, snapshotHistory } from '../git/history-graph.ts';
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
import { captureInputSelection } from './input-selection.ts';

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
	private location?:string;
	private generation=0;
	private branches:HistoryScope='current';
	private search:HistorySearch={query:'',field:'all'};
	private selected='';
	private comparison=newComparison();
	private searchInput?:HTMLInputElement;
	private dismissSearch?:()=>void;
	private dispose?:()=>void;
	private dismissDetails?:()=>boolean;
	private anchor?:()=>{oid?:string;offset:number;scroll:number;listFocused:boolean};

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
		this.scope.register([],'Escape',event=>{
			if(event.defaultPrevented || event.isComposing)return undefined;
			if(this.searchInput && this.searchInput.doc.activeElement===this.searchInput){
				this.dismissSearch?.();return false;
			}
			if(this.dismissDetails?.())return false;
			return undefined;
		});
	}
	getViewType(){return historyType;}
	getIcon(){return 'git-graph';}
	getDisplayText(){
		const label=this.plugin.t('知识库历史','Library history');
		return this.location?this.location+' · '+label:label;
	}
	getState(){return {id:this.id};}
	override onClose(){this.generation++;this.dispose?.();return Promise.resolve();}

	async setState(state:unknown,result:ViewStateResult){
		const generation=++this.generation;
		const previous=this.anchor?.();
		const input=captureInputSelection(this.searchInput);
		if(input)this.search.query=input.value;
		this.dispose?.();
		this.dispose=undefined;this.anchor=undefined;this.searchInput=undefined;this.dismissSearch=undefined;this.dismissDetails=undefined;
		await super.setState(state,result);
		const live=()=>generation===this.generation;
		if(!live())return;
		this.contentEl.empty();
		if(!state || typeof state!=='object' || !('id' in state) || typeof state.id!=='string')return;
		const restore=this.id===state.id?previous:undefined;
		if(this.id!==state.id){
			this.location=undefined;
			this.branches='current';this.search={query:'',field:'all'};this.selected='';this.comparison=newComparison();
		}
		const id=this.id=state.id,plugin=this.plugin,t=plugin.t;
		const el=this.contentEl.createDiv({cls:'kb-git-history'});
		try{
			assertGitEnabled(plugin);
			const lib=(await plugin.loadCatalog()).find(l=>l.identity?.id===id && !l.duplicate && !l.problem);
			if(!live())return;
			if(!lib)throw new Error(t('无法定位知识库','Could not locate the library'));
			this.location=lib.location;
			const prefs=plugin.preferences(id);
			const options:HistoryDisplay={graph:true,refs:true,stashes:true,worktree:true,author:prefs.historyAuthor!=='hidden',
				date:prefs.historyDate,sha:true,authorWidth:16,dateWidth:12,shaWidth:10,refPosition:'before',detailLayout:'below',
				...historyOptions(plugin)};
			const dir=await plugin.disk.path(lib.location),scope=this.branches;
			const snapshot=await snapshotHistory(dir,scope,options.stashes);
			if(!live())return;
			const workLabel=t('未提交的更改','Uncommitted changes');
			const worktree=options.worktree && (typeof scope==='string' || snapshot.tips.length>0)?await historyWorktree(dir).catch((error:unknown)=>{
				if(live() && !snapshot.detached)new Notice(String(error));return undefined;
			}):undefined;
			if(!live())return;
			const graph=new GraphHistory(dir,snapshot,!!worktree);
			const virtual=graph.workingRow?1:0;
			const formatter=new Intl.DateTimeFormat();
			const date=(timestamp:number)=>formatter.format(timestamp*1000);
			const author=(name:string)=>displayAuthor(name,prefs.historyAuthor);
			const currentRef=snapshot.detached?'':'refs/heads/'+snapshot.branch;
			const scopedRefs=typeof scope==='string'?undefined:new Set(scope);
			const report=(error:unknown)=>{if(live())new Notice(String(error));};
			const reload=()=>{void this.setState({id},{history:false});};
			const changeScope=(scope:HistoryScope)=>{
				this.branches=scope;this.anchor=undefined;reload();
			};
			el.createEl('h3',{text:lib.location});
			const bar=el.createDiv({cls:'kb-history-toolbar'});
			historyScopeControl(bar,plugin,snapshot,scope,changeScope);
			historyButton(bar,t('刷新历史','Refresh history'),'refresh-cw').onclick=reload;
			const head=historyButton(bar,t('转到 HEAD','Go to HEAD'),'locate-fixed');
			head.disabled=!snapshot.head;
			historyDisplayControl(bar,plugin,options,reload);
			const searchBar=el.createDiv({cls:'kb-history-toolbar'});
			const panels=el.createDiv({cls:'kb-history-panels'});
			panels.toggleClass('kb-history-panels-side',options.detailLayout==='side');
			const list=panels.createDiv({cls:'kb-history-table',attr:{'aria-label':t('提交历史','Commit history'),role:'group',tabindex:'-1'}});
			list.dataset.scope=typeof scope==='string'?scope:'custom';
			list.setCssProps({'--kb-history-author-width':options.authorWidth+'ch',
				'--kb-history-date-width':options.dateWidth+'ch','--kb-history-sha-width':options.shaWidth+'ch'});
			const detail=panels.createDiv({cls:'kb-history-detail'});
			const empty=list.createEl('p',{text:scopedRefs?t('所选引用没有可显示的提交','No commits to show for the selected refs'):
				t('还没有提交','No commits yet')});empty.hidden=true;
			const refsAt=(oid:string)=>snapshot.labels.get(oid)??[];
			const rowAt=(index:number)=>virtual && index===0?graph.workingRow:graph.rows[index-virtual];
			const indexOf=(oid:string)=>{
				if(oid===worktreeOid && virtual)return 0;
				const index=graph.indices.get(oid);
				return index===undefined?-1:index+virtual;
			};
			const present=(oid:string)=>indexOf(oid)>=0;
			let loaded=0,detailRequest=0,pendingJump=0,paging=false;
			const load=async(count:number)=>{
				await graph.load(Math.max(batchSize,count-virtual),live);
				if(!live())return;
				loaded=Math.max(loaded,Math.min(count,graph.rows.length+virtual));
				window.update(loaded,Math.max(1,graph.width));
				empty.hidden=loaded>0;
			};
			const closeDetail=()=>{
				if(!live() || !this.selected)return false;
				pendingJump++;detailRequest++;
				this.selected='';this.comparison=newComparison();
				detail.empty();window.mark(-1,'');window.focusVisible();
				return true;
			};
			this.dismissDetails=closeDetail;
			const paintDetail=async()=>{
				const index=indexOf(this.selected),row=rowAt(index);
				const request=++detailRequest;
				const focused=detail.doc.activeElement;
				const restoreFocus=focused && detail.contains(focused);
				const focusKey=restoreFocus?focused.closest<HTMLElement>('[data-detail-focus]')?.dataset.detailFocus:undefined;
				window.mark(row?index:-1,this.comparison.override?'':this.comparison.base);
				detail.empty();
				if(!row)return;
				const {commit}=row;
				const children=[...(graph.children.get(commit.oid)??[])];
				if(graph.workingRow?.commit.parents.includes(commit.oid))children.unshift(worktreeOid);
				const rendered=renderHistoryDetail(detail,{plugin,lib,dir,commit,refs:refsAt(commit.oid),head:snapshot.head,
					children,currentRef,detached:snapshot.detached,author:author(commit.author),date:prefs.historyDate?date(commit.timestamp):'',
					control:this.comparison,close:closeDetail,active:()=>live() && request===detailRequest,
					repaint:()=>{void paintDetail().catch(report);},jump:oid=>{void jump(oid,true).catch(report);},
					menu:(anchor,ref)=>showMenu(commit.oid,{anchor,ref})});
				if(restoreFocus){
					const target=focusKey?detail.querySelector<HTMLElement>(`[data-detail-focus="${focusKey}"]:not(:disabled)`):null;
					(target??detail.querySelector<HTMLElement>('.kb-history-detail-close'))?.focus({preventScroll:true});
				}
				await rendered;
			};
			const pick=(oid:string,compare=false)=>{
				if(this.selected!==oid){
					this.comparison.parent='';this.comparison.override='';this.comparison.reversed=false;
					if(compare && this.selected)this.comparison.base=this.selected;
					this.selected=oid;
				}
				void paintDetail().catch(report);
			};
			const locate=async(oid:string,active=live)=>{
				if(oid===worktreeOid && !virtual)return -1;
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
			const moveRow=(index:number,step:number)=>{
				const request=++pendingJump;
				void (async()=>{
					const target=Math.max(0,index+step);
					if(target===index)return;
					if(target>=loaded)await load(target+batchSize);
					if(!live() || request!==pendingJump)return;
					const next=Math.min(target,loaded-1),row=rowAt(next);
					if(next!==index && row)await jump(row.commit.oid,true);
				})().catch(report);
			};
			const showMenu=(oid:string,trigger:{anchor?:HTMLElement;event?:MouseEvent;ref?:GraphRef;showRefs?:()=>void})=>{
				if(!live())return;
				const commit=present(oid) && oid!==worktreeOid?rowAt(indexOf(oid))?.commit:undefined;
				const origin=this.comparison.base || (this.selected && this.selected!==oid?this.selected:snapshot.head);
				showHistoryMenu({plugin,lib,dir,commit,detached:snapshot.detached,stash:refsAt(oid).some(ref=>ref.kind==='stash'),...trigger,
					selectBase:base=>{
						if(!live())return;
						this.comparison.base=base;this.comparison.override='';this.comparison.reversed=false;
						if(this.selected){pendingJump++;void paintDetail().catch(report);}
						else void jump(base).catch(report);
					},
					openComparison:origin && origin!==oid && (origin===this.comparison.base || present(origin))?target=>{
						if(!live() || origin===target)return;
						pendingJump++;this.comparison={...newComparison(),base:origin};pick(target);
					}:undefined});
			};
			const expandRefs=(button:HTMLElement,oid:string,refs:GraphRef[])=>{
				if(!live())return;
				const menu=new Menu();
				for(const ref of refs)menu.addItem(item=>item.setTitle(refKind(ref.kind,t)+' · '+ref.name)
					.onClick(()=>showMenu(oid,{anchor:button,ref})));
				const rect=button.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.bottom},button.doc);
			};
			const createRow=(index:number)=>{
				const row=rowAt(index)!;
				const {commit}=row,oid=commit.oid,working=oid===worktreeOid;
				const entries=refsAt(oid);
				const primary=entries.find(ref=>scopedRefs?.has(historyRefKey(ref)))??entries.find(ref=>ref.ref===currentRef);
				const refs=primary?[primary,...entries.filter(ref=>ref!==primary)]:entries;
				const title=working?workLabel:commit.message.split('\n')[0]||t('无提交说明','No commit message');
				const button=list.doc.createElement('button');
				button.addClass('kb-history-row');
				button.type='button';button.dataset.oid=oid;
				const node=working?'worktree':oid===snapshot.head?'head':refs.some(ref=>ref.kind==='stash')?'stash':
					commit.parents.length>1?'merge':'commit';
				const tooltip=working?workLabel:[title,oid,commit.author,date(commit.timestamp),...refs.map(ref=>ref.name)].join('\n');
				if(options.graph)drawCommitGraph(button,row,tooltip,node);
				const labels=()=>{
					if(!options.refs || !refs.length)return;
					const group=button.createSpan({cls:'kb-history-labels'});
					for(const [i,ref] of refs.slice(0,2).entries())group.createSpan({text:ref.name,cls:['kb-history-ref','kb-history-ref-'+ref.kind,...(ref.ref===currentRef?['kb-history-ref-current']:[])],
						attr:{'data-ref-index':String(i),title:refKind(ref.kind,t)+' · '+ref.name}});
					for(const [visible,layout] of [[2,'wide'],[1,'compact']] as const)if(refs.length>visible){
						group.createSpan({text:'+'+(refs.length-visible),cls:['kb-history-ref','kb-history-ref-more','kb-history-ref-more-'+layout],
							attr:{title:refs.slice(visible).map(ref=>ref.name).join('\n'),'data-more-refs':String(visible)}});
					}
				};
				if(options.refPosition==='before')labels();
				button.createSpan({cls:'kb-history-subject',text:title,attr:{title:tooltip}});
				if(options.refPosition==='after')labels();
				if(working && worktree){
					button.createSpan({cls:'kb-commit-meta',text:t('暂存','Staged')+' '+worktree.staged+' · '+t('未暂存','Unstaged')+' '+worktree.unstaged});
				}else{
					if(options.author)button.createSpan({cls:['kb-commit-meta','kb-history-author'],
						text:prefs.historyAuthor==='hidden'?commit.author:author(commit.author)});
					if(options.date)button.createSpan({cls:['kb-commit-meta','kb-history-date'],text:date(commit.timestamp)});
					if(options.sha)button.createEl('code',{cls:'kb-history-sha',text:oid.slice(0,10)});
				}
				const openOverflow=(target:Element|null)=>{
					const badge=target?.closest<HTMLElement>('[data-more-refs]');
					if(!badge)return false;
					expandRefs(badge,oid,refs.slice(Number(badge.dataset.moreRefs)));
					return true;
				};
				const rowMenu={anchor:button,showRefs:refs.length?()=>expandRefs(button,oid,refs):undefined};
				button.onclick=event=>{
					const target=event.target as Node|null;
					if(target?.instanceOf(Element) && openOverflow(target))return;
					pendingJump++;pick(oid,event.ctrlKey||event.metaKey);
				};
				button.oncontextmenu=event=>{
					event.preventDefault();event.stopPropagation();
					const node=event.target as Node|null;
					const target=node?.instanceOf(Element)?node:null;
					if(openOverflow(target))return;
					const badge=target?.closest<HTMLElement>('[data-ref-index]');
					showMenu(oid,badge?{event,ref:refs[Number(badge.dataset.refIndex)]}:{...rowMenu,event});
				};
				button.onkeydown=event=>{
					const children=graph.children.get(oid)??[];
					const sameLaneChild=children.find(child=>rowAt(indexOf(child))?.color===row.color);
					const sameLaneParent=row.parents.findIndex(rail=>rail.color===row.color);
					const keys:Record<string,()=>void>={
						ArrowUp:()=>moveRow(index,-1),
						ArrowDown:()=>moveRow(index,1),
						PageUp:()=>moveRow(index,-Math.max(1,Math.floor(list.clientHeight/historyRowHeight))),
						PageDown:()=>moveRow(index,Math.max(1,Math.floor(list.clientHeight/historyRowHeight))),
						ArrowLeft:()=>{const parent=commit.parents[Math.max(0,sameLaneParent)];if(parent)void jump(parent,true).catch(report);},
						ArrowRight:()=>{const child=graph.workingRow?.commit.parents.includes(oid)?worktreeOid:sameLaneChild??children[0];
							if(child)void jump(child,true).catch(report);},
						Home:()=>{const first=rowAt(0);if(first)void jump(first.commit.oid,true).catch(report);},
						End:()=>{const last=rowAt(loaded-1);if(last)void jump(last.commit.oid,true).catch(report);},
						ContextMenu:()=>showMenu(oid,rowMenu),
					};
					const action=event.shiftKey && event.key==='F10'?keys.ContextMenu:event.ctrlKey || event.metaKey || event.altKey?
						undefined:keys[event.key];
					if(action){event.preventDefault();event.stopPropagation();action();}
				};
				return button;
			};
			const window=new HistoryWindow(list,createRow,t('比较基线','Comparison base'),()=>{
				if(!live() || paging || (graph.complete && loaded>=graph.rows.length+virtual))return;
				paging=true;void load(loaded+batchSize).catch(report).finally(()=>{paging=false;});
			});
			const search=renderHistorySearch(searchBar,graph,t,this.search,prefs.historyAuthor,date,live,()=>this.selected,
				oid=>{void jump(oid).catch(report);},()=>{pendingJump++;window.focusVisible();},report);
			this.searchInput=search.search;
			this.dismissSearch=search.clear;
			if(restore)input?.restore(search.search);
			this.dispose=()=>{window.destroy();search.close();};
			this.anchor=()=>{
				const index=Math.floor(list.scrollTop/historyRowHeight);
				return {oid:rowAt(index)?.commit.oid,offset:list.scrollTop-index*historyRowHeight,scroll:list.scrollTop,
					listFocused:list.contains(list.doc.activeElement)};
			};
			head.onclick=()=>{void (async()=>{
				const request=++pendingJump,active=()=>live() && request===pendingJump;
				if(typeof scope==='string' || await locate(snapshot.head,active)>=0){if(active())await jump(snapshot.head);}
				else if(active()){
					this.branches='current';this.selected=snapshot.head;this.comparison=newComparison();this.anchor=undefined;reload();
				}
			})().catch(report);};
			const selected=this.selected?await locate(this.selected):-1;
			const anchor=restore?.oid?await locate(restore.oid):-1;
			if(!live())return;
			if(selected<0){this.selected='';this.comparison=newComparison();}
			await load(Math.max(selected+1,anchor+batchSize,batchSize));
			if(!live())return;
			if(this.selected)void paintDetail().catch(report);
			if(restore){
				list.scrollTop=anchor>=0?anchor*historyRowHeight+restore.offset:restore.scroll;
				if(restore.listFocused && list.doc.activeElement===list.doc.body)window.focusVisible();
			}
			else if(selected>=0)window.reveal(selected);
			search.restore();
		}catch(error){if(live())el.createEl('p',{cls:'kb-git-error',text:String(error),attr:{role:'alert'}});}
	}
}
