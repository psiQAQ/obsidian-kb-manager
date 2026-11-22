import { setIcon } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { historyRefKey } from '../git/history-graph.ts';
import type { GraphRef, HistoryScope, HistorySnapshot } from '../git/history-graph.ts';
import { Dialog } from './dialog.ts';

export const historyColumns=['graph','refs','stashes','worktree','author','date','sha'] as const;
type Column=typeof historyColumns[number];
type Translator=KnowledgeBaseManager['t'];
type Width='authorWidth'|'dateWidth'|'shaWidth';
export type HistoryOptions=Partial<Record<Column,boolean> & Record<Width,number> & {
	refPosition:'before'|'after';detailLayout:'inline'|'below'|'side';
}>;
export type HistoryDisplay=Required<HistoryOptions>;
export type SearchField='all'|'message'|'author'|'sha'|'refs'|'date';

const columnLabels=(t:Translator):Record<Column,string>=>({
	graph:t('分支连线','Branch lanes'),refs:t('引用标签','Ref labels'),stashes:t('贮藏','Stashes'),
	worktree:t('未提交的更改','Uncommitted changes'),author:t('作者','Author'),date:t('日期','Date'),sha:t('短 SHA','Short SHA'),
});

export function historyOptions(plugin:KnowledgeBaseManager):HistoryOptions {
	const raw:unknown=plugin.app.loadLocalStorage(plugin.manifest.id+':git-graph-display');
	const result:HistoryOptions={};
	if(raw && typeof raw==='object'){
		const fields=raw as Record<string,unknown>;
		for(const key of historyColumns){
			const value=fields[key];
			if(typeof value==='boolean')result[key]=value;
		}
		for(const key of ['authorWidth','dateWidth','shaWidth'] as const){
			const value=fields[key];
			if(typeof value==='number' && Number.isInteger(value) && value>=6 && value<=32)result[key]=value;
		}
		if(fields.refPosition==='before' || fields.refPosition==='after')result.refPosition=fields.refPosition;
		if(fields.detailLayout==='inline' || fields.detailLayout==='below' || fields.detailLayout==='side')result.detailLayout=fields.detailLayout;
	}
	return result;
}

export function refKind(kind:GraphRef['kind'],t:Translator) {
	return {head:'HEAD',local:t('本地分支','Local branch'),remote:t('远端跟踪分支','Remote-tracking branch'),
		tag:t('标签','Tag'),stash:t('贮藏','Stash')}[kind];
}

export function historyButton(el:HTMLElement,label:string,icon?:string){
	const button=el.createEl('button',{text:icon?undefined:label,attr:{type:'button','aria-label':label,title:label}});
	if(icon)setIcon(button,icon);
	return button;
}

export function historyScopeControl(
	bar:HTMLElement,plugin:KnowledgeBaseManager,snapshot:HistorySnapshot,scope:HistoryScope,onChange:(scope:HistoryScope)=>void,
){
	const t=plugin.t;
	const select=bar.createEl('select',{cls:'kb-history-scope',attr:{'aria-label':t('历史范围','History scope')}});
	select.createEl('option',{value:'current',text:snapshot.detached?t('当前 HEAD（分离状态）','Current HEAD (detached)'):
		t('当前分支','Current branch')+' · '+snapshot.branch});
	select.createEl('option',{value:'all',text:t('所有引用','All refs')});
	select.createEl('option',{value:'custom',text:t('所选引用','Selected refs')});
	select.value=typeof scope==='string'?scope:'custom';
	const pickBranches=()=>{
		const refs=snapshot.refs.filter(ref=>ref.kind!=='head');
		const chosen=new Set(typeof scope==='string'?[snapshot.detached?'':'refs/heads/'+snapshot.branch]:scope);
		for(const ref of [...chosen])if(!refs.some(item=>historyRefKey(item)===ref))chosen.delete(ref);
		const modal=new Dialog(plugin.app,t('选择引用','Select refs'));
		const filterLabel=t('筛选引用名称','Filter ref names');
		const filter=modal.contentEl.createEl('input',{type:'search',placeholder:filterLabel,attr:{'aria-label':filterLabel}});
		const controls=modal.contentEl.createDiv({cls:'kb-history-toolbar'});
		const selectVisible=historyButton(controls,t('选择筛选结果','Select filtered refs'));
		const clear=historyButton(controls,t('清除所选引用','Clear selected refs'));
		const list=modal.contentEl.createDiv({cls:'kb-history-branches'});
		const choices:{key:string;label:HTMLLabelElement;checkbox:HTMLInputElement}[]=[];
		for(const kind of ['local','remote','tag','stash'] as const){
			const members=refs.filter(ref=>ref.kind===kind);
			if(!members.length)continue;
			const group=list.createEl('fieldset');
			group.createEl('legend',{text:refKind(kind,t)});
			for(const ref of members){
				const label=group.createEl('label');
				const checkbox=label.createEl('input',{type:'checkbox'});
				const key=historyRefKey(ref);
				choices.push({key,label,checkbox});
				checkbox.checked=chosen.has(key);
				label.createSpan({text:ref.name});
				checkbox.onchange=()=>{
					if(checkbox.checked)chosen.add(key);else chosen.delete(key);
					updateControls();
				};
			}
		}
		if(!refs.length)list.createEl('p',{text:t('尚无可选引用','No refs to select yet')});
		filter.oninput=()=>{
			const query=filter.value.trim().toLowerCase();
			for(const {label} of choices)label.hidden=!label.textContent?.toLowerCase().includes(query);
			updateControls();
		};
		const apply=modal.action(t('应用','Apply'),()=>{
			modal.close();onChange([...chosen]);return Promise.resolve();
		});
		const updateControls=()=>{
			selectVisible.disabled=!choices.some(({label,checkbox})=>!label.hidden && !checkbox.checked);
			clear.disabled=!chosen.size;
			apply.setDisabled(!chosen.size);
		};
		selectVisible.onclick=()=>{
			for(const {key,label,checkbox} of choices)if(!label.hidden){chosen.add(key);checkbox.checked=true;}
			updateControls();
		};
		clear.onclick=()=>{
			chosen.clear();for(const {checkbox} of choices)checkbox.checked=false;
			updateControls();
		};
		updateControls();
		modal.open();
	};
	select.onchange=()=>{
		if(select.value==='custom'){
			select.value=typeof scope==='string'?scope:'custom';
			pickBranches();
		}else onChange(select.value==='all'?'all':'current');
	};
	if(typeof scope!=='string'){
		const keys=new Set(snapshot.refs.map(historyRefKey));
		const count=scope.filter(key=>keys.has(key)).length;
		historyButton(bar,t('选择引用','Select refs')+' ('+count+')').onclick=pickBranches;
		const missing=scope.length-count;
		if(missing)bar.createSpan({text:t(`${missing} 个所选引用已不可用或被隐藏`, `${missing} selected refs are unavailable or hidden`),attr:{role:'status'}});
	}
}

export function historyDisplayControl(
	bar:HTMLElement,plugin:KnowledgeBaseManager,options:HistoryDisplay,onChange:()=>void,
){
	const t=plugin.t;
	historyButton(bar,t('图谱显示设置','Graph display settings'),'sliders-horizontal').onclick=()=>{
		const modal=new Dialog(plugin.app,t('图谱显示设置','Graph display settings'));
		const settings=modal.contentEl.createDiv({cls:'kb-history-branches'});
		const values:HistoryOptions={};
		for(const [key,text] of Object.entries(columnLabels(t)) as [Column,string][]){
			const label=settings.createEl('label');
			const checkbox=label.createEl('input',{type:'checkbox'});
			checkbox.checked=options[key];
			checkbox.onchange=()=>{values[key]=checkbox.checked;};
			label.createSpan({text});
		}
		const positions=modal.contentEl.createDiv({cls:'kb-history-branches'});
		const choice=<K extends 'refPosition'|'detailLayout'>(key:K,label:string,items:Record<HistoryDisplay[K],string>)=>{
			const row=positions.createEl('label');
			row.createSpan({text:label});
			const select=row.createEl('select');
			for(const [value,text] of Object.entries<string>(items))select.createEl('option',{value,text});
			select.value=options[key];
			select.onchange=()=>{values[key]=select.value as HistoryDisplay[K];};
		};
		choice('refPosition',t('引用标签位置','Ref label position'),{before:t('标题前','Before subject'),after:t('标题后','After subject')});
		choice('detailLayout',t('详情位置','Details position'),{
			inline:t('提交行下方','Under commit row'),below:t('列表下方','Below list'),side:t('右侧','Alongside'),
		});
		for(const [key,text] of [
			['authorWidth',t('作者列宽','Author column width')],['dateWidth',t('日期列宽','Date column width')],
			['shaWidth',t('SHA 列宽','SHA column width')],
		] as const){
			const row=positions.createEl('label');
			row.createSpan({text});
			const width=row.createEl('input',{type:'number',value:String(options[key]),attr:{min:'6',max:'32',step:'1'}});
			width.onchange=()=>{
				const value=width.valueAsNumber;
				if(Number.isFinite(value))values[key]=Math.min(32,Math.max(6,Math.round(value)));
				width.value=String(values[key]??options[key]);
			};
		}
		modal.action(t('应用','Apply'),()=>{
			plugin.app.saveLocalStorage(plugin.manifest.id+':git-graph-display',{...historyOptions(plugin),...values});
			modal.close();onChange();return Promise.resolve();
		});
		modal.open();
	};
}

export function historySearchControl(bar:HTMLElement,t:Translator,field:SearchField){
	const label=t('搜索字段','Search field');
	const select=bar.createEl('select',{attr:{'aria-label':label}});
	const labels:Record<SearchField,string>={
		all:t('全部字段','All fields'),message:t('提交说明','Commit message'),author:t('作者','Author'),
		sha:t('提交 SHA','Commit SHA'),refs:t('引用名称','Ref name'),date:t('显示日期','Displayed date'),
	};
	for(const [value,text] of Object.entries(labels))select.createEl('option',{value,text});
	select.value=field;
	return select;
}
