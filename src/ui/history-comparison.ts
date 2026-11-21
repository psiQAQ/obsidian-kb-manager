import { Menu, Notice, TFile, setIcon } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { compareHistory, currentHistoryPath } from '../git/index-history.ts';
import type { HistoryFile, HistorySide } from '../git/index-history.ts';
import { verifyWorkingFile } from '../git/index-actions.ts';
import { assertGitEnabled } from './device.ts';
import { reviewHistoryRestore } from './history-advanced.ts';
import { showDiff, showHistorySnapshot } from './source-diff.ts';

interface ComparisonOptions {
	plugin:KnowledgeBaseManager;
	lib:Library;
	dir:string;
	before:HistorySide;
	after:HistorySide;
	active:()=>boolean;
	commitParent?:'first'|'other';
}

const changeLabel={
	A:['新增','Added'],D:['删除','Deleted'],M:['修改','Modified'],R:['重命名','Renamed'],C:['复制','Copied'],T:['类型变化','Type changed'],
} as const;

const reviewKey=(side:HistorySide,version?:HistoryFile['before'])=>[
	side.kind,side.kind==='commit'?side.oid:null,version?.file,version?.oid,version?.mode,
];
const fileReviewKey=(before:HistorySide,after:HistorySide,file:HistoryFile)=>JSON.stringify([
	reviewKey(before,file.before),reviewKey(after,file.after),
]);

function reviewMarks(plugin:KnowledgeBaseManager,key:string) {
	const raw:unknown=plugin.app.loadLocalStorage(key);
	return new Set(Array.isArray(raw)?raw.filter((item:unknown):item is string=>typeof item==='string'):[]);
}

function fileMenu(anchor:HTMLElement,options:ComparisonOptions,file:HistoryFile) {
	const {plugin,lib,dir,before,after}=options,t=plugin.t,id=lib.identity!.id;
	const menu=new Menu(),add=(label:string,icon:string,run:()=>Promise<void>,disabled=false)=>{
		menu.addItem(item=>item.setTitle(label).setIcon(icon).setDisabled(disabled).onClick(()=>{void run().catch(error=>new Notice(String(error)));}));
	};
	const versions=[[after,file.after],[before,file.before]] as const;
	const toCurrentNote=async(side:HistorySide,file:string)=>{
		assertGitEnabled(plugin);
		await recheck(plugin.disk,plugin.config,lib);
		const path=side.kind==='commit'?await currentHistoryPath(dir,side.oid,file):file;
		const relative=path?lib.location+'/'+path:'';
		const item=relative?plugin.app.vault.getAbstractFileByPath(relative):undefined;
		if(!path || !(item instanceof TFile) || item.extension.toLowerCase()!=='md' || item.path!==relative)
			throw new Error(t('无法确认此历史文件对应的当前笔记','Could not match this version to a current note'));
		await verifyWorkingFile(dir,path);
		return {item,path};
	};
	const noteVersion=versions.find(([side,version])=>side.kind==='commit' && version?.file.toLowerCase().endsWith('.md'))
		?? versions.find(([side,version])=>side.kind==='working' && version?.file.toLowerCase().endsWith('.md'));
	if(noteVersion)add(t('打开当前笔记','Open current note'),'go-to-file',async()=>{
		const {item}=await toCurrentNote(noteVersion[0],noteVersion[1]!.file);
		await plugin.app.workspace.getLeaf('tab').openFile(item);
	});
	const copy=async(value:string)=>{
		const clipboard=anchor.ownerDocument.defaultView?.navigator.clipboard??navigator.clipboard;
		await clipboard.writeText(value);
	};
	add(t('复制库内路径','Copy path within library'),'copy',()=>copy(file.file));
	if(file.before && file.before.file!==file.file){
		const oldFile=file.before.file;
		add(t('复制旧库内路径','Copy previous path within library'),'copy',()=>copy(oldFile));
	}
	for(const [side,version] of versions){
		if(side.kind!=='commit' || !version)continue;
		const tag=' · '+side.oid.slice(0,10);
		menu.addSeparator();
		add(t('打开只读历史版本','Open read-only historical version')+tag,'file-lock',
			()=>showHistorySnapshot(plugin,{id,file:version.file,commit:side.oid}));
		if(version.file.toLowerCase().endsWith('.md'))add(t('将此版本与当前笔记比较','Compare this version with current note')+tag,'git-compare',async()=>{
			const {path}=await toCurrentNote(side,version.file);
			await showDiff(plugin,{id,file:path,staged:false,comparison:{before:side,after:{kind:'working'},oldFile:version.file}});
		});
		add(t('从此版本恢复文件…','Restore file from this version…')+tag,'undo',
			()=>reviewHistoryRestore(plugin,lib,dir,side.oid,version.file),lib.identity?.archived);
	}
	const rect=anchor.getBoundingClientRect();
	menu.showAtPosition({x:rect.left,y:rect.bottom});
}

export async function renderHistoryComparison(el:HTMLElement,options:ComparisonOptions) {
	const {plugin,lib,dir,before,after,active,commitParent}=options,t=plugin.t;
	const id=lib.identity!.id;
	const loading=el.createEl('p',{text:t('正在读取文件变更…','Loading file changes…'),attr:{role:'status'}});
	let files:HistoryFile[];
	try{
		assertGitEnabled(plugin);
		await recheck(plugin.disk,plugin.config,lib);
		files=await compareHistory(dir,before,after);
	}catch(error){
		if(active())el.createEl('p',{cls:'kb-git-error',text:String(error),attr:{role:'alert'}});
		return;
	}finally{loading.remove();}
	if(!active())return;
	if(!files.length){
		el.createEl('p',{text:t('此比较没有文件变更','No file changes in this comparison')});return;
	}
	const reviewable=before.kind!=='working' && after.kind!=='working';
	const keys=new Map(reviewable?files.map(file=>[file,fileReviewKey(before,after,file)]):[]);
	const storage=plugin.manifest.id+':history-review:'+id;
	const toolbar=el.createDiv({cls:'kb-comparison-controls'});
	const toggle=toolbar.createEl('button',{attr:{type:'button'}});
	const status=toolbar.createSpan({attr:{role:'status'}});
	const rows=el.createDiv({cls:'kb-comparison-files'});
	let tree=plugin.preferences(id).tree;
	let marks=reviewable?reviewMarks(plugin,storage):new Set<string>();
	const updateStatus=()=>{
		if(!reviewable){status.setText(files.length+' '+t('个文件有变更','files changed'));return;}
		const reviewed=[...keys.values()].filter(key=>marks.has(key)).length;
		status.setText(t('已审阅','Reviewed')+' '+reviewed+' / '+files.length);
	};
	const saveMark=(key:string,reviewed:boolean)=>{
		const updated=reviewMarks(plugin,storage);
		if(reviewed)updated.add(key);else updated.delete(key);
		plugin.app.saveLocalStorage(storage,updated.size?[...updated]:null);
		marks=updated;updateStatus();
	};
	const openDiff=async(file:HistoryFile)=>{
		const oldFile=file.before?.file;
		if(commitParent && after.kind==='commit' && (!oldFile || oldFile===file.file)){
			const parent=commitParent==='other' && before.kind==='commit'?{parent:before.oid}:{};
			await showDiff(plugin,{id,file:file.file,staged:false,commit:after.oid,...parent});
		}else await showDiff(plugin,{id,file:file.file,staged:false,comparison:{before,after,...(oldFile?{oldFile}:{})}});
	};
	const render=()=>{
		rows.empty();
		toggle.setText(tree?t('显示列表','Show list'):t('显示文件树','Show file tree'));
		const folders=new Map([['',rows]]);
		for(const file of files){
			const parts=file.file.split('/');
			const basename=parts.pop()!;
			let group=rows,prefix='';
			if(tree)for(const part of parts){
				prefix+=part+'/';
				let folder=folders.get(prefix);
				if(!folder){
					const section=group.createEl('details',{cls:'kb-comparison-folder'});
					section.open=true;section.createEl('summary',{text:part});
					folders.set(prefix,folder=section.createDiv());
				}
				group=folder;
			}
			const row=group.createDiv({cls:'kb-comparison-file'});
			const rename=file.before && file.before.file!==file.file;
			const path=rename?file.before!.file+' → '+file.file:file.file;
			const [zh,en]=changeLabel[file.status],description=t(zh,en);
			const button=row.createEl('button',{cls:'kb-comparison-open',attr:{type:'button',title:description+' · '+path,'aria-label':description+' · '+path}});
			button.createSpan({cls:'kb-history-change',text:file.status,attr:{'aria-hidden':'true'}});
			button.createSpan({text:rename?file.before!.file+' → '+(tree?basename:file.file):tree?basename:file.file});
			const key=keys.get(file);
			const review=key?row.createEl('input',{type:'checkbox',attr:{'aria-label':t('标记为已审阅','Mark as reviewed')+' · '+path}}):undefined;
			if(key && review){
				review.title=t('已审阅','Reviewed');
				review.checked=marks.has(key);
				review.onchange=()=>{
					try{saveMark(key,review.checked);}
					catch(error){review.checked=marks.has(key);new Notice(String(error));}
				};
			}
			const open=async()=>{
				await openDiff(file);
				if(key && review && !review.checked){saveMark(key,true);review.checked=true;}
			};
			button.onclick=()=>{if(active())void open().catch(error=>new Notice(String(error)));};
			const more=row.createEl('button',{cls:'kb-comparison-menu',attr:{type:'button','aria-haspopup':'menu',
				'aria-label':t('文件操作','File actions')+' · '+path,title:t('文件操作','File actions')}});
			setIcon(more,'ellipsis');
			more.onclick=()=>{if(active())fileMenu(more,options,file);};
			button.oncontextmenu=event=>{event.preventDefault();if(active())fileMenu(button,options,file);};
		}
		updateStatus();
	};
	toggle.onclick=()=>{tree=!tree;render();};
	render();
}
