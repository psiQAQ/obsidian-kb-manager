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
import { destinationParentField } from './registry-path-field.ts';
import { vaultExclusions, showExclusionPlan } from './template-filter.ts';
import { planMoveReferences, selectMoveReferences, verifyMoveReferences } from './move-links.ts';

export async function upgradeManifest(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow) {
	const preview=await previewManifestUpgrade(plugin.disk,lib);
	if(!preview)return;
	const {relative,id,ignores,log,checks}=preview;
	const dialog=new Dialog(plugin.app,tr('升级知识库清单','Upgrade library manifest'),owner);
	dialog.facts([[tr('文件','File'),relative],[tr('清单格式','Manifest schema'),'1 → 2'],[tr('知识库 ID','Library ID'),id]]);
	dialog.contentEl.createEl('p',{text:log.exists?tr('使用现有的 .log/ 目录保存检验日志。','Use the existing .log/ directory for check logs.'):tr('创建 .log/ 目录以保存检验日志。','Create .log/ for check logs.')});
	if(ignores.before!==ignores.after){
		dialog.contentEl.createEl('p',{text:tr('在本库 .gitignore 末尾追加规则','Append rules to this library’s .gitignore')});
		dialog.contentEl.createEl('pre').createEl('code',{text:ignores.after.slice(ignores.before?.length ?? 0).trim()});
	}
	if(checks.manual.length){
		dialog.contentEl.createEl('p',{text:tr('专项文件需人工核对。本次升级会更新清单格式和日志位置。','Review the check files manually. This upgrade updates the manifest format and log location.')});
		dialog.lines(checks.manual);
	} else if(!checks.files.length){
		dialog.contentEl.createEl('p',{text:tr('当前版本提供通用体检和日志。','General checks and logs are available for this template version.')});
	} else {
		for(const file of checks.files){
			const item=dialog.contentEl.createEl('details');
			item.createEl('summary',{text:(file.existing?tr('已匹配 ','Matched '):tr('创建 ','Create '))+lib.location+'/'+file.path});
			item.createEl('p',{text:'SHA-256 '+file.fingerprint});
			item.createEl('pre').createEl('code',{text:file.content});
		}
	}
	dialog.action(tr('应用清单升级','Apply manifest upgrade'),async()=>{
		await plugin.exclusive(lib.location,()=>applyManifestUpgrade(plugin.disk,plugin.config,preview));
		dialog.close();await plugin.refresh();
	}).setCta();
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
	const previous=lib.identity;
	let name=previous.displayName,description=previous.description;
	const dialog=new Dialog(plugin.app,tr('编辑知识库',"Edit knowledge base"),owner);
	dialog.lines([lib.location+'/kb.toml']);
	dialog.text(tr('显示名',"Display name"),name,v=>{name=v;});dialog.multiline(tr('简介',"Description"),description,v=>{description=v;});
	const confirm=(archive:boolean)=>{
		const next=new Dialog(plugin.app,tr('确认清单修改',"Confirm manifest changes"),owner);
		next.lines([lib.location+'/kb.toml',previous.displayName+' → '+name,previous.description+' → '+description,
			tr('归档：',"Archived: ")+String(previous.archived)+' → '+String(archive)]);
		next.action(tr('应用',"Apply"),async()=>{
			if(!name.trim())throw new Error(tr('请输入显示名',"Enter a display name"));
			await plugin.exclusive(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await changeIdentity(plugin,lib,value=>{value.displayName=name;value.description=description;value.archived=archive;});
			});
			next.close();dialog.close();await plugin.refresh();
		});next.open();
	};
	dialog.action(tr('预览元信息',"Preview metadata"),()=>{confirm(previous.archived);return Promise.resolve();});
	dialog.action(previous.archived?tr('恢复活动状态',"Restore to active"):tr('归档',"Archive"),()=>{confirm(!previous.archived);return Promise.resolve();});
	dialog.open();
}

export async function maintainBindings(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow) {
	const library=await recheck(plugin.disk,plugin.config,lib);
	const {manual,repairs}=await examineBindings(plugin.disk,library,plugin.templateAssets(library));
	const dialog=new Dialog(plugin.app,tr('维护受管文件','Maintain managed files'),owner);
	dialog.facts([[tr('知识库','Library'),library.location]]);
	if(manual.length)dialog.lines(manual);
	if(!manual.length && !repairs.length)dialog.contentEl.createEl('p',{text:tr('没有需要维护的受管文件。','No managed files require maintenance.')});
	for(const item of repairs){
		new Setting(dialog.contentEl).setName(item.file).setDesc(item.fields.join('\n')).addButton(button=>{
			button.setButtonText(tr('预览修复','Preview repair')).onClick(()=>{
				const preview=new Dialog(plugin.app,tr('预览受管文件修复','Preview managed file repair'),owner);
				preview.lines([library.location+'/'+item.file,...item.fields]);
				preview.contentEl.createEl('pre').createEl('code',{text:item.after});
				if(!library.identity?.archived)preview.action(tr('应用此修复','Apply this repair'),async()=>{
					await plugin.exclusive(library.location,()=>applyRepair(plugin.disk,plugin.config,library,item,visible(plugin),plugin.templateAssets(library)));
					preview.close();dialog.close();
					await plugin.refresh();
					const fresh=await inspect(plugin.disk,library.location);
					if(fresh)await maintainBindings(plugin,fresh,owner);
				}).setCta();
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

function moveReview(plugin:KnowledgeBaseManager,record:MoveRecord,title:string,owner:Window){
	const dialog=new V3Dialog(plugin.app,title,owner);
	dialog.facts([[tr('源目录','Source folder'),record.source],[tr('目标目录','Destination folder'),record.destination]]);
	dialog.contentEl.createEl('p',{text:tr('移动整个知识库目录，包括目录内的 Git 数据。成功后登记列表指向目标路径。',
		'Move the entire library folder, including its Git data. After the move, the registry points to the destination.')});
	if(record.changes.length){
		dialog.contentEl.createEl('h3',{text:tr('移动后更新的文件','Files updated after the move')});
		for(const change of record.changes){
			const file=dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
			file.createEl('summary',{text:record.destination+'/'+change.file});
			dialogContents(file).lines(change.fields);
			file.createEl('pre',{cls:'kb-v3-code'}).createEl('code',{text:change.after});
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
	dialog.action(tr('继续移动','Resume move'),async()=>{
		await resumeMove(plugin,record);
		dialog.close();
		await reviewMovedLinks(plugin,record,owner);
	}).setCta();
	dialog.open();
}

export function move(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow){
	let name=lib.location.split('/').at(-1)!;
	const dialog=new V3Dialog(plugin.app,tr('移动或重命名知识库',"Move or rename knowledge base"),owner);
	const selectedTarget=dialog.contentEl.createDiv({cls:'kb-move-locations'});
	let parent:string|null=null;
	const showPaths=()=>{
		selectedTarget.empty();
		dialogContents(selectedTarget).facts([[tr('源目录','Source folder'),lib.location],
			[tr('目标目录','Destination folder'),parent!==null && name ? [parent,name].filter(Boolean).join('/') : tr('待填写','Pending')]]);
	};
	showPaths();
	const getParent=destinationParentField(dialog,plugin.app,plugin.config,plugin.disk.registry,{
		title:tr('选择目标父目录','Choose destination parent folder'),onSelect:path=>{parent=path;showPaths();},
	});
	dialog.text(tr('目标目录名',"Destination folder name"),name,v=>{name=v;showPaths();});
	dialog.action(tr('预览',"Preview"),async()=>{
		const target=getParent(), targetName=name;
		const skeleton=plugin.templateAssets(lib);
		const store=vaultExclusions(plugin.app,plugin.disk.registry);
		const plan=await planMove(plugin.disk,plugin.config,lib,target,targetName,skeleton,store);
		const references=await planMoveReferences(plugin,plan);
		const confirm=moveReview(plugin,plan,tr('预览目录移动',"Review directory move"),owner);
		const selectedReferences=selectMoveReferences(confirm.contentEl,plugin.app.vault,plan,references);
		confirm.action(tr('移动完整目录',"Move entire directory"),async()=>{
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
		}).setCta();confirm.open();
	}).setCta();dialog.open();
}
