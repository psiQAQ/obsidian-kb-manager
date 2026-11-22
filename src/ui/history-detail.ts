import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { recheck } from '../kb/catalog.ts';
import type { GraphCommit, GraphRef } from '../git/history-graph.ts';
import { readHistoryCommit } from '../git/history-graph.ts';
import type { HistorySide } from '../git/index-history.ts';
import { assertGitEnabled } from './device.ts';
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
	currentRef:string;
	detached:boolean;
	control:HistoryComparisonControl;
	gesture?:{from:string;to:string};
	active:()=>boolean;
	repaint:()=>void;
	close:()=>void;
	setBase:(oid:string)=>void;
	clearComparison:()=>void;
	jump:(oid:string)=>void;
	menu:(anchor:HTMLElement,ref?:GraphRef)=>void;
}

const side=(oid?:string):HistorySide=>oid==='worktree'?{kind:'working'}:oid && oid!=='empty-tree'?{kind:'commit',oid}:{kind:'empty'};

const localCommitDate=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'2-digit',day:'2-digit',
	hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});

async function renderCommitMetadata(el:HTMLElement,{plugin,lib,dir,commit,active}:DetailOptions) {
	const t=plugin.t;
	const loading=el.createEl('p',{text:t('正在读取提交详情…','Loading commit details…'),attr:{role:'status'}});
	try{
		assertGitEnabled(plugin);
		await recheck(plugin.disk,plugin.config,lib);
		if(!active())return;
		const info=await readHistoryCommit(dir,commit.oid);
		if(!active())return;
		const metadata=el.createEl('dl',{cls:'kb-history-detail-meta'});
		const field=(label:string)=>{
			const row=metadata.createDiv({cls:'kb-history-detail-field'});
			row.createEl('dt',{text:label});
			return row.createEl('dd');
		};
		field(t('提交','Commit')).createEl('code',{text:commit.oid});
		const parents=field(t('父提交','Parents'));
		for(const [index,oid] of info.parent.entries()){
			if(index)parents.append(', ');
			parents.createEl('code',{text:oid});
		}
		if(!info.parent.length)parents.setText(t('无','None'));
		field(t('作者','Author')).setText(info.author.name+' <'+info.author.email+'>');
		field(t('提交者','Committer')).setText(info.committer.name+' <'+info.committer.email+'>');
		field(t('日期','Date')).setText(localCommitDate.format(info.committer.timestamp*1000));
		if(info.author.timestamp!==info.committer.timestamp)
			field(t('作者日期','Author date')).setText(localCommitDate.format(info.author.timestamp*1000));
		if(info.message)el.createEl('p',{cls:'kb-commit-body',text:info.message});
	}catch(error){
		if(active())el.createEl('p',{cls:'kb-git-error',text:String(error),attr:{role:'alert'}});
	}finally{loading.remove();}
}

export async function renderHistoryDetail(el:HTMLElement,opts:DetailOptions){
	const {plugin,lib,dir,commit,refs,head,children,currentRef,detached,control,gesture,active,repaint,close,setBase,clearComparison,jump,menu}=opts;
	const t=plugin.t,working=commit.oid==='worktree';
	const parent=commit.parents.includes(control.parent)?control.parent:commit.parents[0];
	control.parent=parent??'';
	const base=control.base && control.base!==commit.oid?control.base:undefined;
	const originalBefore=control.override?commit.oid:gesture?.from??base??(working?head:parent);
	const originalAfter=control.override || gesture?.to || commit.oid;
	const before=side(control.reversed?originalAfter:originalBefore),after=side(control.reversed?originalBefore:originalAfter);
	const explicit=!!(control.override || gesture || base);
	const sideLabel=(value:HistorySide,full=false)=>value.kind==='commit'?(full?value.oid:value.oid.slice(0,10)):
		value.kind==='empty'?t('空树','Empty tree'):t('工作区','Working tree');
	const summary=el.createDiv({cls:'kb-history-detail-summary'});
	const files=el.createDiv({cls:'kb-history-detail-files'});
	const heading=summary.createDiv({cls:'kb-history-detail-heading'});
	heading.createEl('h4',{text:explicit?sideLabel(before)+' → '+sideLabel(after):
		working?t('未提交的更改','Uncommitted changes'):commit.oid.slice(0,10)});
	const actions=historyButton(heading,t('更多操作','More actions'),'ellipsis');
	actions.setAttribute('aria-haspopup','menu');
	actions.onclick=()=>{if(active())menu(actions);};
	const closeButton=historyButton(heading,t('关闭提交详情','Close commit details'),'x');
	closeButton.addClass('kb-history-detail-close');
	closeButton.onclick=()=>{if(active())close();};
	if(explicit){
		const explanation=summary.createEl('p',{cls:'kb-history-detail-direction'});
		explanation.append(t('展示从 ','Displaying all changes from '));
		explanation.createEl('code',{text:sideLabel(before,true)});
		explanation.append(t(' 到 ',' to '));
		explanation.createEl('code',{text:sideLabel(after,true)});
		explanation.append(t(' 的所有变更。','.'));
	}
	const commitDetails=!explicit && !working?renderCommitMetadata(summary.createDiv(),opts):undefined;
	if(refs.length){
		const labels=summary.createDiv({cls:'kb-history-comparison'});
		for(const ref of refs){
			const label=labels.createEl('button',{text:ref.name,cls:['kb-history-ref','kb-history-ref-'+ref.kind,...(ref.ref===currentRef?['kb-history-ref-current']:[])],
				attr:{type:'button','aria-haspopup':'menu','aria-label':refKind(ref.kind,t)+' · '+ref.name}});
			label.onclick=()=>{if(active())menu(label,ref);};
		}
	}
	const comparison=summary.createDiv({cls:'kb-history-comparison'});
	const navigate=(values:readonly string[],name:string,parentOptions=false)=>{
		if(!values.length)return;
		const label=(oid:string)=>oid==='worktree'?t('工作区','Working tree'):oid.slice(0,10);
		if(values.length===1){
			const oid=values[0]!,button=historyButton(comparison,name,parentOptions?'arrow-up':'arrow-down');
			button.title=name+' · '+label(oid);
			button.onclick=()=>{if(active())jump(oid);};
			return;
		}
		const dropdown=comparison.createEl('select',{attr:{'aria-label':name}});
		dropdown.createEl('option',{value:'',text:name});
		for(const [i,oid] of values.entries())dropdown.createEl('option',{value:oid,text:parentOptions?
			t('父提交','Parent')+' '+(i+1)+' · '+label(oid):label(oid)});
		dropdown.onchange=()=>{if(active() && dropdown.value)jump(dropdown.value);};
	};
	navigate(commit.parents,t('转到父提交','Go to parent'),true);
	navigate(children,t('转到子提交','Go to child'));
	const chooseParent=(oid:string)=>{if(active()){control.parent=oid;repaint();}};
	const comparingMergeParents=!explicit && commit.parents.length>1;
	if(comparingMergeParents){
		const choose=comparison.createEl('select',{cls:'kb-history-parent',
			attr:{'aria-label':t('比较父提交','Comparison parent'),'data-detail-focus':'parent'}});
		for(const [i,oid] of commit.parents.entries())
			choose.createEl('option',{value:oid,text:t('父提交','Parent')+' '+(i+1)+' · '+oid.slice(0,10)});
		choose.value=control.parent;
		choose.onchange=()=>chooseParent(choose.value);
	}
	if(!explicit)comparison.createSpan({text:sideLabel(before)+' → '+sideLabel(after)});
	const action=(key:string,label:string,icon?:string)=>{
		const button=historyButton(comparison,label,icon);
		button.dataset.detailFocus=key;
		return button;
	};
	const swap=action('swap',t('交换比较方向','Swap comparison direction'),'arrow-left-right');
	swap.onclick=()=>{if(active()){control.reversed=!control.reversed;repaint();}};
	const empty=action('empty',t('与空树比较','Compare with empty tree'));
	empty.disabled=control.override==='empty-tree';
	empty.onclick=()=>{if(active()){control.override='empty-tree';control.reversed=true;repaint();}};
	if(!working){
		const pin=action('base',t('设为比较基线','Set comparison base'));
		pin.disabled=control.base===commit.oid && !control.override;
		pin.onclick=()=>{if(active())setBase(commit.oid);};
		const compare=action('working',t('与工作区比较','Compare with working tree'));
		compare.disabled=control.override==='worktree';
		compare.onclick=()=>{if(active()){control.override='worktree';control.reversed=false;repaint();}};
	}
	if(control.base || control.override || gesture){
		const clear=action('clear',t('清除比较选择','Clear comparison selection'));
		clear.onclick=()=>{if(active())clearComparison();};
	}
	if(control.base && !control.override){
		const label=t('比较基线','Comparison base')+' · ';
		const base=side(control.base);
		comparison.createSpan({cls:'kb-history-base',text:label+sideLabel(base),attr:{title:label+(base.kind==='commit'?base.oid:sideLabel(base))}});
	}
	const commitParent=!working && !control.reversed && !control.override && !gesture &&
		(!control.base || control.base===commit.oid || control.base===parent)?parent===commit.parents[0]?'first':'other':undefined;
	const [result]=await Promise.all([renderHistoryComparison(files,{plugin,lib,dir,before,after,active,commitParent,detached}),commitDetails]);
	if(!active() || result!=='empty')return;
	if(!comparingMergeParents){
		files.createEl('p',{text:t('此比较没有文件变更','No file changes in this comparison'),attr:{role:'status'}});
		return;
	}
	const index=commit.parents.indexOf(control.parent)+1;
	const noChanges=t(`与父提交 ${index} 比较时，没有可显示的文件变更。`, `No file changes to display against parent ${index}.`);
	const emptyState=files.createDiv({cls:'kb-history-empty-comparison'});
	emptyState.createEl('p',{text:noChanges,attr:{role:'status'}});
	const alternatives=emptyState.createDiv({cls:'kb-history-comparison'});
	for(const [i,oid] of commit.parents.entries())if(oid!==parent){
		const button=historyButton(alternatives,t(`与父提交 ${i+1} 比较`, `Compare with parent ${i+1}`));
		button.dataset.detailFocus='parent';
		button.dataset.historyParentOid=oid;
		button.onclick=()=>chooseParent(oid);
	}
}
