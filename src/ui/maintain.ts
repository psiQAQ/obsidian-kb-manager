import { tr } from '../i18n.ts';
import { MarkdownView, Setting, TFile } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { digest } from '../fs/vault.ts';
import { inspect, recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { applyManifestUpgrade, previewManifestUpgrade } from '../kb/manifest-upgrade.ts';
import { applyRepair, examineBindings } from '../kb/maintenance.ts';
import type { VisibleFiles } from '../kb/maintenance.ts';
import { executeMove,planMove } from '../kb/move.ts';
import type { MoveFiles, MoveRecord } from '../kb/move.ts';
import { moveVaultPath } from '../kb/move-link-text.ts';
import { readMoveReference } from '../kb/move-references.ts';
import { changeIdentity } from './identity.ts';
import { Dialog, V3Dialog, dialogContents } from './dialog.ts';
import { changeActions, changeComparison, panelGroup } from './change-preview.ts';
import { destinationParentField } from './registry-path-field.ts';
import { vaultExclusions, showExclusionPlan } from './template-filter.ts';
import { planMoveReferences, selectMoveReferences, verifyMoveReferences } from './move-links.ts';
import { showAddedIgnoreRules } from './registry-ignore.ts';

export async function upgradeManifest(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow) {
	const preview=await previewManifestUpgrade(plugin.disk,lib);
	if(!preview)return;
	const {relative,id,ignores,log,checks}=preview;
	const dialog=new Dialog(plugin.app,tr('升级知识库清单','Upgrade library manifest'),owner);
	dialog.facts([[tr('文件','File'),relative],[tr('知识库 ID','Library ID'),id]]);
	changeComparison(dialog.contentEl,[
		{label:tr('清单格式','Manifest schema'),before:'1',after:'2'},
		{label:tr('检验日志目录','Check log folder'),before:log.exists?'.log/':tr('目录缺失','Folder missing'),after:'.log/'},
	]);
	if(ignores.before!==ignores.after){
		showAddedIgnoreRules(dialog.contentEl,lib.location+'/.gitignore',ignores.before,
			ignores.after.slice(ignores.before?.length ?? 0).trim());
	}
	if(checks.manual.length){
		dialog.contentEl.createEl('p',{text:tr('专项文件需人工核对。本次升级会更新清单格式和日志位置。','Review the check files manually. This upgrade updates the manifest format and log location.')});
		dialog.lines(checks.manual);
	} else if(!checks.files.length){
		dialog.contentEl.createEl('p',{text:tr('当前版本提供通用检验和日志。','General checks and logs are available for this template version.')});
	} else {
		for(const file of checks.files){
			const item=dialog.contentEl.createEl('details');
			item.createEl('summary',{text:(file.existing?tr('已匹配 ','Matched '):tr('创建 ','Create '))+lib.location+'/'+file.path});
			item.createEl('p',{text:'SHA-256 '+file.fingerprint});
			if(file.existing)item.createEl('pre').createEl('code',{text:file.content});
			else changeComparison(item,[{
				label:tr('文件内容','File content'),before:tr('文件缺失','File missing'),after:file.content,code:true,
			}]);
		}
	}
	changeActions(dialog.contentEl,[{label:tr('应用清单升级','Apply manifest upgrade'),primary:true,run:async()=>{
		await plugin.exclusive(lib.location,()=>applyManifestUpgrade(plugin.disk,plugin.config,preview));
		dialog.close();await plugin.refresh();
	}}]);
	dialog.open();
}

function editorContents(plugin:KnowledgeBaseManager,file:TFile) {
	const contents:string[]=[];
	plugin.app.workspace.iterateAllLeaves(leaf=>{
		const view=leaf.view;
		if(view instanceof MarkdownView && view.file===file && view.getMode()==='source')contents.push(view.editor.getValue());
	});
	return contents;
}

const editorText=(text:string)=>text.replace(/^\uFEFF/u,'').replace(/\r\n/gu,'\n');
function verifyEditors(path:string,text:string,editors:readonly string[]){
	if(editors.some(value=>editorText(value)!==editorText(text)))
		throw new Error(tr('请先保存编辑器中的修改并重新预览：','Save the edits in the open editor and preview again: ')+path);
}

export function visible(plugin:KnowledgeBaseManager,protectEditors=false):VisibleFiles {
	const vault=plugin.app.vault;
	return {
		create:async(relative,content)=>{await plugin.disk.path(relative);await vault.create(relative,content);},
		replace:async(relative,before,after)=>{
			await plugin.disk.path(relative);
			const file=vault.getAbstractFileByPath(relative);
			if(!(file instanceof TFile))throw new Error(tr('等待 Obsidian 刷新路径后，请在管理器中继续',"Wait for Obsidian to refresh the path, then continue in the manager"));
			await vault.process(file,text=>{
				if(digest(text)!==before)throw new Error(tr('文件已变化，请重新预览：',"File changed. Preview again: ")+relative);
				if(protectEditors)verifyEditors(relative,text,editorContents(plugin,file));
				return after;
			});
		}
	};
}

export function edit(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow){
	if(!lib.identity)return;
	const previous=lib.identity,expected={...lib},target=lib.location+'/kb.toml';
	const draft={displayName:previous.displayName,description:previous.description};
	const labels={displayName:tr('显示名','Display name'),description:tr('简介','Description')};
	const fields=['displayName','description'] as const;
	const changedFields=(next:typeof draft)=>fields.filter(field=>next[field]!==previous[field]);
	const status=(archived:boolean)=>archived?tr('已归档','Archived'):tr('活动中','Active');
	const dialog=new Dialog(plugin.app,tr('编辑知识库',"Edit knowledge base"),owner);
	dialog.facts([[tr('清单','Manifest'),target]]);
	const capture=()=>{
		if(!draft.displayName.trim())throw new Error(tr('请输入显示名','Enter a display name'));
		return {...draft};
	};
	const apply=async(next:typeof draft,archived?:boolean,preview?:Dialog)=>{
		await plugin.exclusive(expected.location,async()=>{
			await recheck(plugin.disk,plugin.config,expected);
			await changeIdentity(plugin,expected,value=>{
				Object.assign(value,next);
				if(archived!==undefined)value.archived=archived;
			});
		});
		preview?.close();dialog.close();await plugin.refresh();
	};
	const archiveAction=previous.archived?tr('恢复活动状态','Restore to active'):tr('归档','Archive');
	const review=(origin:HTMLButtonElement,archived?:boolean)=>{
		const next=capture();
		const title=archived===undefined?tr('预览清单变更','Review manifest changes'):
			archived?tr('确认归档知识库','Confirm library archive'):tr('确认恢复活动状态','Confirm library restoration');
		const preview=new Dialog(plugin.app,title,owner).returnFocusTo(origin);
		preview.facts([[tr('写入位置','Save to'),target]]);
		const rows=changedFields(next).map(field=>({label:labels[field],before:previous[field],after:next[field]}));
		if(archived!==undefined)rows.unshift({label:tr('状态','Status'),before:status(previous.archived),after:status(archived)});
		changeComparison(preview.contentEl,rows);
		changeActions(preview.contentEl,[{
			label:archived===undefined?tr('应用变更','Apply changes'):archiveAction,
			run:()=>apply(next,archived,preview),primary:true,
		}]);
		preview.open();return Promise.resolve();
	};
	const information=panelGroup(dialog.contentEl,tr('知识库信息','Library information'));
	const update=(field:keyof typeof draft,value:string)=>{
		draft[field]=value;
		actions.setDisabled(!changedFields(draft).length);
	};
	dialogContents(information).text(labels.displayName,draft.displayName,value=>update('displayName',value));
	dialogContents(information).multiline(labels.description,draft.description,value=>update('description',value));
	const actions=changeActions(information,[
		{label:tr('预览变更','Preview changes'),run:review},
		{label:tr('直接应用','Apply directly'),run:()=>apply(capture()),primary:true},
	]);
	actions.setDisabled(true);
	const archive=panelGroup(dialog.contentEl,tr('归档状态','Archive status'));
	dialogContents(archive).facts([[tr('当前状态','Current status'),status(previous.archived)]]);
	changeActions(archive,[{label:archiveAction,run:origin=>review(origin,!previous.archived)}]);
	dialog.open();
}

export async function maintainBindings(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow) {
	const library=await recheck(plugin.disk,plugin.config,lib);
	const originals=new Map<string,string>();
	const {manual,repairs}=await examineBindings(plugin.disk,library,plugin.templateAssets(library),library.location,originals);
	const dialog=new Dialog(plugin.app,tr('维护受管文件','Maintain managed files'),owner);
	dialog.facts([[tr('知识库','Library'),library.location]]);
	if(manual.length)dialog.lines(manual);
	if(!manual.length && !repairs.length)dialog.contentEl.createEl('p',{text:tr('没有需要维护的受管文件。','No managed files require maintenance.')});
	for(const item of repairs){
		new Setting(dialog.contentEl).setName(item.file).setDesc(item.fields.join('\n')).addButton(button=>{
			button.setButtonText(tr('预览修复','Preview repair')).onClick(()=>{
				const preview=new Dialog(plugin.app,tr('预览受管文件修复','Preview managed file repair'),owner);
				preview.returnFocusTo(button.buttonEl);
				preview.lines([library.location+'/'+item.file,...item.fields]);
				changeComparison(preview.contentEl,[{
					label:tr('文件内容','File content'),before:item.before===null?tr('文件缺失','File missing'):
						(originals.get(item.file) ?? tr('预览无旧内容','Previous contents unavailable')),
					after:item.after,code:true,
				}]);
				if(!library.identity?.archived)changeActions(preview.contentEl,[{label:tr('应用此修复','Apply this repair'),primary:true,run:async()=>{
					await plugin.exclusive(library.location,()=>applyRepair(plugin.disk,plugin.config,library,item,visible(plugin),plugin.templateAssets(library)));
					preview.close();dialog.close();
					await plugin.refresh();
					const fresh=await inspect(plugin.disk,library.location);
					if(fresh)await maintainBindings(plugin,fresh,owner);
				}}]);
				preview.open();
			});
		});
	}
	dialog.open();
}

async function resumeMove(plugin:KnowledgeBaseManager,record:MoveRecord){
	const {vault}=plugin.app;
	const files:MoveFiles={...visible(plugin,true),async renameFolder(source,destination){
		const folder=vault.getFolderByPath(source);
		if(!folder)throw new Error(tr('等待 Obsidian 刷新目录后继续移动：','Wait for Obsidian to index the folder before resuming: ')+source);
		// Vault.rename preserves file objects and open tabs. The preview controls
		// which links are updated, so use Vault rather than FileManager here.
		await vault.rename(folder,destination);
	}};
	try{
		await plugin.exclusive(record.source,()=>executeMove(plugin.disk,plugin.config,record,files,v=>plugin.recordMove(v),
			plugin.kepanoSkeleton,vaultExclusions(plugin.app,plugin.disk.registry)),true);
	}finally{await plugin.refresh();}
}

async function reviewMovedLinks(plugin:KnowledgeBaseManager,record:MoveRecord,owner:Window){
	const unresolved=await verifyMoveReferences(plugin,record);
	if(!unresolved.length || owner.closed)return;
	const review=new V3Dialog(plugin.app,tr('复核移动后的引用','Review moved references'),owner);
	review.contentEl.createEl('p',{text:tr('目录已移动。请在 Obsidian 完成索引后核对以下引用。',
		'The library moved. Check these references after Obsidian finishes indexing.')});
	review.lines(unresolved);
	review.open();
}

function moveReview(plugin:KnowledgeBaseManager,record:MoveRecord,title:string,owner:Window,originals?:ReadonlyMap<string,string>){
	const dialog=new V3Dialog(plugin.app,title,owner);
	changeComparison(dialog.contentEl,[{label:tr('知识库目录','Library folder'),before:record.source,after:record.destination}]);
	dialog.contentEl.createEl('p',{text:tr('移动整个知识库目录，包括目录内的 Git 数据。成功后登记列表指向目标路径。',
		'Move the entire library folder, including its Git data. After the move, the registry points to the destination.')});
	if(record.changes.length){
		dialog.contentEl.createEl('h3',{text:tr('移动后更新的文件','Files updated after the move')});
		for(const change of record.changes){
			const file=dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
			file.createEl('summary',{text:record.destination+'/'+change.file});
			dialogContents(file).lines(change.fields);
			changeComparison(file,[{
				label:tr('文件内容','File content'),before:originals?.get(change.file) ??
					tr('恢复记录未保留旧内容','Original contents unavailable in recovery record'),after:change.after,code:true,
			}]);
		}
	}
	if(record.warnings.length){
		dialog.contentEl.createEl('h3',{text:tr('需人工核对','Manual review required')});
		dialog.lines(record.warnings);
	}
	if(record.exclusions)showExclusionPlan(dialog,record.exclusions);
	return dialog;
}

export function reviewPendingMove(plugin:KnowledgeBaseManager,record:MoveRecord,owner:Window=activeWindow){
	const dialog=moveReview(plugin,record,tr('继续待完成的目录移动','Resume pending library move'),owner);
	dialog.facts([[tr('恢复记录','Recovery state'),record.phase==='prepared' ?
		tr('已记录计划，待核对实际位置','Plan saved. Verify the current folder location.') :
		tr('已移动目录，待核对受管文件、所选引用和登记','Folder moved. Verify the managed files, selected references and registration.')]]);
	if(Array.isArray(record.references) && record.references.length){
		dialog.contentEl.createEl('h3',{text:tr('已确认更新的引用文件','Reference files selected for update')});
		dialog.lines(record.references.filter(edit=>edit && typeof edit.file==='string')
			.map(edit=>moveVaultPath(edit.file,record.source,record.destination)));
	}
	changeActions(dialog.contentEl,[{label:tr('继续移动','Resume move'),primary:true,run:async()=>{
		await resumeMove(plugin,record);
		dialog.close();
		await reviewMovedLinks(plugin,record,owner);
	}}]);
	dialog.open();
}

export function move(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow){
	let name=lib.location.split('/').at(-1)!;
	const dialog=new V3Dialog(plugin.app,tr('移动或重命名知识库',"Move or rename knowledge base"),owner);
	const selectedTarget=dialog.contentEl.createDiv({cls:'kb-move-locations'});
	let parent:string|null=null;
	const showPaths=()=>{
		selectedTarget.empty();
		changeComparison(selectedTarget,[{label:tr('知识库目录','Library folder'),before:lib.location,
			after:parent!==null && name ? [parent,name].filter(Boolean).join('/') : tr('待填写','Pending')}]);
	};
	showPaths();
	const getParent=destinationParentField(dialog,plugin.app,plugin.config,plugin.disk.registry,{
		title:tr('选择目标父目录','Choose destination parent folder'),onSelect:path=>{parent=path;showPaths();},
	});
	dialog.text(tr('目标目录名',"Destination folder name"),name,v=>{name=v;showPaths();});
	dialog.action(tr('预览目录移动',"Preview directory move"),async origin=>{
		const target=getParent(), targetName=name;
		const skeleton=plugin.templateAssets(lib);
		const store=vaultExclusions(plugin.app,plugin.disk.registry);
		const originals=new Map<string,string>();
		const plan=await planMove(plugin.disk,plugin.config,lib,target,targetName,skeleton,store,originals);
		const references=await planMoveReferences(plugin,plan);
		const confirm=moveReview(plugin,plan,tr('预览目录移动',"Review directory move"),owner,originals);
		confirm.returnFocusTo(origin);
		const selectedReferences=selectMoveReferences(confirm.contentEl,plugin.app.vault,plan,references);
		changeActions(confirm.contentEl,[{label:tr('移动完整目录',"Move entire directory"),primary:true,run:async()=>{
			const selected=selectedReferences();
			const fresh=await planMove(plugin.disk,plugin.config,lib,target,targetName,skeleton,store);
			const stale=()=>new Error(tr('预览已变化，请重新预览',"Preview has changed. Open a new preview."));
			if(JSON.stringify({...fresh,token:plan.token})!==JSON.stringify(plan))throw stale();
			if(selected.length){
				const latest=await planMoveReferences(plugin,fresh);
				const byPath=new Map(latest.groups.flatMap(group=>group.files.map(edit=>[edit.file,edit] as const)));
				for(const edit of selected){
					if(JSON.stringify(byPath.get(edit.file))!==JSON.stringify(edit))throw stale();
					const file=plugin.app.vault.getFileByPath(edit.file);
					const editors=file ? editorContents(plugin,file) : [];
					if(editors.length)verifyEditors(edit.file,await readMoveReference(plugin.disk,edit.file),editors);
				}
			}
			await plugin.disk.registry.assertWritable();
			const record={...plan,references:selected};
			await plugin.recordMove(record);
			confirm.close();dialog.close();
			await resumeMove(plugin,record);
			await reviewMovedLinks(plugin,record,owner);
		}}]);confirm.open();
	}).setCta();dialog.open();
}
