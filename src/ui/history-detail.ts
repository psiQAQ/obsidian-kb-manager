import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import type { GraphCommit, GraphRef } from '../git/history-graph.ts';
import type { HistorySide } from '../git/index-history.ts';
import { historyButton, refKind } from './history-controls.ts';
import { renderHistoryComparison } from './history-comparison.ts';

export type HistoryComparisonControl={base:string;parent:string;override:string;reversed:boolean};

interface DetailOptions {
	plugin:KnowledgeBaseManager;
	lib:Library;
	dir:string;
	commit:GraphCommit;
	refs:GraphRef[];
	head:string;
	children:readonly string[];
	worktree:boolean;
	control:HistoryComparisonControl;
	active:()=>boolean;
	repaint:()=>void;
	jump:(oid:string)=>void;
	menu:(anchor:HTMLElement,ref?:GraphRef)=>void;
}

const side=(oid?:string):HistorySide=>oid==='worktree'?{kind:'working'}:oid && oid!=='empty-tree'?{kind:'commit',oid}:{kind:'empty'};

export async function renderHistoryDetail(el:HTMLElement,opts:DetailOptions){
	const {plugin,lib,dir,commit,refs,head,children,worktree,control,active,repaint,jump,menu}=opts;
	const t=plugin.t,working=commit.oid==='worktree';
	const heading=el.createDiv({cls:'kb-history-detail-heading'});
	heading.createEl('h4',{text:working?t('未提交的更改','Uncommitted changes'):
		commit.message.split('\n')[0]||t('无提交说明','No commit message')});
	const actions=historyButton(heading,t('更多操作','More actions'),'ellipsis');
	actions.setAttribute('aria-haspopup','menu');
	actions.onclick=()=>menu(actions);
	if(!working){
		const metadata=el.createDiv({cls:'kb-history-detail-meta'});
		metadata.createEl('code',{text:commit.oid});
		metadata.createSpan({text:commit.author+' · '+new Date(commit.timestamp*1000).toLocaleString()});
		const body=commit.message.split('\n').slice(1).join('\n').trim();
		if(body)el.createEl('p',{cls:'kb-commit-body',text:body});
	}
	if(refs.length){
		const labels=el.createDiv({cls:'kb-history-comparison'});
		for(const ref of refs){
			const label=labels.createEl('button',{text:ref.name,cls:['kb-history-ref','kb-history-ref-'+ref.kind],
				attr:{type:'button','aria-haspopup':'menu','aria-label':refKind(ref.kind,t)+' · '+ref.name}});
			label.onclick=()=>menu(label,ref);
		}
	}
	const parent=commit.parents.includes(control.parent)?control.parent:commit.parents[0];
	control.parent=parent??'';
	const nav=el.createDiv({cls:'kb-history-comparison'});
	const navigate=(values:readonly string[],name:string,defaultValue:string)=>{
		if(!values.length)return;
		const dropdown=nav.createEl('select',{attr:{'aria-label':name}});
		dropdown.createEl('option',{value:'',text:name});
		for(const oid of values)dropdown.createEl('option',{value:oid,text:oid==='worktree'?t('工作区','Working tree'):oid.slice(0,10)});
		dropdown.value=defaultValue;
		dropdown.onchange=()=>{if(dropdown.value)jump(dropdown.value);};
	};
	navigate(commit.parents,t('转到父提交','Go to parent'),'');
	navigate(children,t('转到子提交','Go to child'),'');
	const comparison=el.createDiv({cls:'kb-history-comparison'});
	const originalBefore=control.override?commit.oid:control.base && control.base!==commit.oid?control.base:working?head:parent;
	const originalAfter=control.override || commit.oid;
	const before=side(control.reversed?originalAfter:originalBefore),after=side(control.reversed?originalBefore:originalAfter);
	if(!control.override && (!control.base || control.base===commit.oid) && commit.parents.length>1){
		const choose=comparison.createEl('select',{cls:'kb-history-parent',attr:{'aria-label':t('比较父提交','Comparison parent')}});
		for(const [i,oid] of commit.parents.entries())
			choose.createEl('option',{value:oid,text:t('父提交','Parent')+' '+(i+1)+' · '+oid.slice(0,10)});
		choose.value=control.parent;
		choose.onchange=()=>{control.parent=choose.value;repaint();};
	}
	const sideLabel=(value:HistorySide)=>value.kind==='commit'?value.oid.slice(0,10):value.kind==='empty'?'∅':t('工作区','Working tree');
	comparison.createSpan({text:sideLabel(before)+' → '+sideLabel(after)});
	const swap=historyButton(comparison,t('交换比较方向','Swap comparison direction'),'arrow-left-right');
	swap.onclick=()=>{control.reversed=!control.reversed;repaint();};
	const empty=historyButton(comparison,t('与空树比较','Compare with empty tree'));
	empty.disabled=control.override==='empty-tree';
	empty.onclick=()=>{control.override='empty-tree';control.reversed=true;repaint();};
	if(!working){
		const pin=historyButton(comparison,t('设为比较基线','Set comparison base'));
		pin.disabled=control.base===commit.oid;
		pin.onclick=()=>{control.base=commit.oid;control.override='';control.reversed=false;repaint();};
		if(worktree){
			const compare=historyButton(comparison,t('与工作区比较','Compare with working tree'));
			compare.disabled=control.override==='worktree';
			compare.onclick=()=>{control.override='worktree';control.reversed=false;repaint();};
		}
	}
	if(control.base || control.override){
		const clear=historyButton(comparison,t('清除比较选择','Clear comparison selection'));
		clear.onclick=()=>{control.base='';control.override='';control.reversed=false;repaint();};
	}
	const commitParent=!working && !control.reversed && !control.override &&
		(!control.base || control.base===commit.oid || control.base===parent)?parent===commit.parents[0]?'first':'other':undefined;
	await renderHistoryComparison(el,{plugin,lib,dir,before,after,active,commitParent});
}
