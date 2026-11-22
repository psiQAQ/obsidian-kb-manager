import type { GraphHistory } from '../git/history-graph.ts';
import type KnowledgeBaseManager from '../main.ts';
import { historyButton, historySearchControl } from './history-controls.ts';
import type { SearchField } from './history-controls.ts';
import { displayAuthor } from '../git/authorship.ts';
import type { GitPreferences } from '../preferences.ts';

export interface HistorySearch {query:string;field:SearchField;stoppedAt?:number}
const scanPageSize=800;

export function renderHistorySearch(
	bar:HTMLElement,graph:GraphHistory,t:KnowledgeBaseManager['t'],state:HistorySearch,
	authorStyle:GitPreferences['historyAuthor'],date:(timestamp:number)=>string,live:()=>boolean,
	selected:()=>string,jump:(oid:string)=>void,restoreFocus:()=>void,report:(error:unknown)=>void,
){
	const select=historySearchControl(bar,t,state.field);
	const label=t('查找提交、引用、作者或日期','Find commits, refs, authors or dates');
	const search=bar.createEl('input',{type:'search',placeholder:label,attr:{'aria-label':label}});
	search.value=state.query;
	const controls=bar.createDiv({cls:'kb-find-controls'});
	let revision=0,timer=0;
	let navigation:((step:number)=>void)|undefined;
	let searching=false;
	const stop=()=>{
		search.win.clearTimeout(timer);revision++;navigation=undefined;searching=false;
		controls.empty();
	};
	const showCanceled=(checked:number)=>controls.createSpan({attr:{role:'status'},
		text:t(`已取消查找，已检查 ${checked} 条提交。`, `Search canceled after scanning ${checked} commits.`)});
	const run=async(activate:boolean,firstFromEnd=false)=>{
		const request=++revision,query=state.query.trim().toLowerCase(),field=state.field;
		const valid=()=>live() && request===revision;
		navigation=undefined;controls.empty();
		if(!query)return;
		searching=true;
		delete state.stoppedAt;
		const status=controls.createSpan({attr:{role:'status'},text:t('查找中…','Searching…')});
		const cancel=historyButton(controls,t('取消查找','Cancel search'));
		cancel.addClass('kb-find-cancel');
		const matches:string[]=[];
		let checked=0;
		const cancelSearch=()=>{
			stop();
			state.stoppedAt=checked;showCanceled(checked);
			search.focus({preventScroll:true});
		};
		cancel.onclick=cancelSearch;
		cancel.onkeydown=event=>{
			if(event.key!=='Escape')return;
			event.preventDefault();event.stopPropagation();cancelSearch();
		};
		const includes=(value:string)=>value.toLowerCase().includes(query);
		while(valid()){
			const end=Math.min(checked+scanPageSize,graph.rows.length);
			for(;checked<end;checked++){
				const {commit}=graph.rows[checked]!;
				if(((field==='all' || field==='sha') && includes(commit.oid)) ||
					((field==='all' || field==='message') && includes(commit.message)) ||
					((field==='all' || field==='author') && (includes(commit.author) || includes(displayAuthor(commit.author,authorStyle)))) ||
					((field==='all' || field==='refs') && graph.snapshot.labels.get(commit.oid)?.some(ref=>includes(ref.name)||includes(ref.ref))) ||
					((field==='all' || field==='date') && includes(date(commit.timestamp))))matches.push(commit.oid);
			}
			status.setText(t(`查找中…已检查 ${checked} 条提交`, `Searching… ${checked} commits scanned`));
			if(checked<graph.rows.length){
				await new Promise<void>(resolve=>search.win.setTimeout(resolve,0));
				continue;
			}
			if(graph.complete)break;
			try{await graph.load(checked+scanPageSize,valid);}
			catch(error){
				if(valid()){stop();report(error);}
				return;
			}
		}
		if(!valid())return;
		searching=false;cancel.remove();
		if(!matches.length){
			status.setText(t(`已检查 ${checked} 条提交，没有匹配结果。`, `No matches found in ${checked} commits.`));return;
		}
		const index=matches.indexOf(selected());
		let at=index>=0?index:firstFromEnd?matches.length-1:0;
		const update=()=>status.setText((at+1)+' / '+matches.length);
		navigation=(step)=>{
			at=(at+step+matches.length)%matches.length;
			update();jump(matches[at]!);
		};
		for(const [text,cls,step] of [
			[t('上一匹配','Previous match'),'kb-find-prev',-1],[t('下一匹配','Next match'),'kb-find-next',1],
		] as const){
			const button=historyButton(controls,text);
			button.addClass(cls);button.disabled=matches.length===1;
			button.onclick=()=>navigation?.(step);
		}
		update();
		if(activate)jump(matches[at]!);
	};
	const queue=()=>{
		stop();
		delete state.stoppedAt;
		timer=search.win.setTimeout(()=>{if(live())void run(true).catch(report);},180);
	};
	search.oninput=event=>{
		if('isComposing' in event && event.isComposing)return;
		state.query=search.value;queue();
	};
	select.onchange=()=>{state.field=select.value as SearchField;queue();};
	search.onkeydown=event=>{
		if(event.isComposing)return;
		if(event.key==='Escape'){
			event.preventDefault();event.stopPropagation();
			stop();delete state.stoppedAt;state.query=search.value='';restoreFocus();
		}
		if(event.key==='Enter' && state.query){
			event.preventDefault();event.stopPropagation();
			search.win.clearTimeout(timer);
			if(navigation)navigation(event.shiftKey?-1:1);
			else if(!searching)void run(true,event.shiftKey).catch(report);
		}
	};
	return {search,restore:()=>{
		if(state.stoppedAt!==undefined)showCanceled(state.stoppedAt);
		else if(state.query)void run(!selected()).catch(report);
	},close:stop};
}
