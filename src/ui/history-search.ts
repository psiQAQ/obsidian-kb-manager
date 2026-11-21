import type { GraphHistory } from '../git/history-graph.ts';
import type KnowledgeBaseManager from '../main.ts';
import { historyButton, historySearchControl } from './history-controls.ts';
import type { SearchField } from './history-controls.ts';
import { displayAuthor } from '../git/authorship.ts';
import type { GitPreferences } from '../preferences.ts';

export interface HistorySearch {query:string;field:SearchField}

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
	const run=async(activate:boolean,firstFromEnd=false)=>{
		const request=++revision,query=state.query.trim().toLowerCase(),field=state.field;
		const valid=()=>live() && request===revision;
		navigation=undefined;controls.empty();
		if(!query)return;
		const status=controls.createSpan({attr:{role:'status'},text:t('查找中…','Searching…')});
		const matches:string[]=[];
		let checked=0;
		while(valid()){
			for(;checked<graph.rows.length;checked++){
				const {commit}=graph.rows[checked]!;
				const includes=(value:string)=>value.toLowerCase().includes(query);
				if(((field==='all' || field==='sha') && includes(commit.oid)) ||
					((field==='all' || field==='message') && includes(commit.message)) ||
					((field==='all' || field==='author') && (includes(commit.author) || includes(displayAuthor(commit.author,authorStyle)))) ||
					((field==='all' || field==='refs') && graph.snapshot.labels.get(commit.oid)?.some(ref=>includes(ref.name)||includes(ref.ref))) ||
					((field==='all' || field==='date') && includes(date(commit.timestamp))))matches.push(commit.oid);
			}
			if(graph.complete)break;
			await graph.load(checked+800,valid);
		}
		if(!valid())return;
		if(!matches.length){status.setText(t('没有匹配的提交','No matching commits'));return;}
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
		revision++;navigation=undefined;
		controls.empty();
		search.win.clearTimeout(timer);
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
			search.win.clearTimeout(timer);revision++;navigation=undefined;
			state.query=search.value='';controls.empty();restoreFocus();
		}
		if(event.key==='Enter' && state.query){
			event.preventDefault();event.stopPropagation();
			search.win.clearTimeout(timer);
			if(navigation)navigation(event.shiftKey?-1:1);
			else void run(true,event.shiftKey).catch(report);
		}
	};
	return {search,restore:()=>{if(state.query)void run(!selected()).catch(report);},close:()=>search.win.clearTimeout(timer)};
}
