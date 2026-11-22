import { MarkdownView, Setting } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { applyTemplateUpdate, previewTemplateUpdate } from '../kb/template-update.ts';
import { templateHost } from '../kb/template-requirements.ts';
import { tr } from '../i18n.ts';
import { V3Dialog } from './dialog.ts';
import { changeActions, changeComparison } from './change-preview.ts';
import { choiceForSource } from './v3-template-catalog.ts';

export async function updateTemplateFiles(plugin:KnowledgeBaseManager,library:Library,owner:Window=activeWindow){
	const sources=await Promise.all(plugin.config.templates.map(source=>choiceForSource(plugin,source)));
	const candidates=sources.filter(source=>source.id===library.identity?.template.id && !source.invalid);
	const dialog=new V3Dialog(plugin.app,tr('更新受管模板文件','Update template files'),owner);
	dialog.facts([[tr('知识库','Library'),library.location],[tr('模板 ID','Template ID'),library.identity?.template.id ?? '']]);
	if(!candidates.length){
		dialog.lines([tr('请在知识库目录与模板设置中登记 ID 匹配的目录模板。','Register a folder template with the matching ID in Library folders and templates settings.')]);
		const invalid=sources.flatMap(source=>source.invalid?[source.source+' · '+source.invalid]:[]);
		if(invalid.length)dialog.lines(invalid);
		dialog.open();
		return;
	}
	let source=candidates[0]!.source;
	const label=tr('模板目录','Template folder');
	new Setting(dialog.contentEl).setName(label).addDropdown(input=>{
		input.selectEl.setAttribute('aria-label',label);
		for(const candidate of candidates)input.addOption(candidate.source,candidate.source);
		input.setValue(source).onChange(value=>{source=value;});
	});
	dialog.action(tr('预览更新','Preview update'),async origin=>{
		const host=templateHost(plugin.app,plugin.manifest.version);
		const plan=await previewTemplateUpdate(plugin.disk,plugin.config,library,source,host);
		const preview=new V3Dialog(plugin.app,tr('受管模板文件更新预览','Preview managed template file updates'),owner).returnFocusTo(origin);
		preview.facts([
			[tr('知识库','Library'),library.location],
			[tr('模板目录','Template folder'),source],
		]);
		changeComparison(preview.contentEl,[{label:tr('模板版本','Template release'),before:plan.installedVersion,after:plan.targetVersion,
			afterLabel:plan.pending || !plan.canApply ? tr('所选版本','Selected release') : undefined}]);
		if(plan.blockers.length)preview.lines(plan.blockers);
		if(plan.optional.length)preview.lines(plan.optional);
		if(plan.pending)preview.lines([tr('冲突、缺失和无法读取的文件需人工处理。处理后再次预览，才能记录所选版本。',
			'Review conflicting, missing and unavailable files manually, then preview again to record the selected release.')]);
		const labels={
			current:tr('已是目标内容','Current'),add:tr('添加','Add'),replace:tr('替换','Replace'),conflict:tr('冲突','Conflict'),
			missing:tr('已缺失','Missing'),retained:tr('保留','Retained'),unavailable:tr('不可用','Unavailable'),
		};
		if(!plan.files.length)preview.lines([tr('当前版本未声明受管文件。','This release declares no managed files.')]);
		for(const file of plan.files){
			const detail=preview.contentEl.createEl('details',{cls:'kb-v3-detail'});
			detail.createEl('summary',{text:labels[file.change]+' · '+file.path});
			if(file.reason)detail.createEl('p',{text:file.reason});
			if(file.change==='retained'){
				changeComparison(detail,[{label:tr('受管文件登记','Managed file record'),before:tr('已登记','Registered'),
					after:tr('移除登记，保留文件','Remove record and keep file'),
					afterLabel:plan.canApply?undefined:tr('拟执行操作','Proposed action')}]);
			} else if(file.after!==undefined && file.change!=='current'){
				const applies=plan.canApply && (file.change==='add' || file.change==='replace');
				const before=file.before ?? (file.change==='unavailable'?tr('无法读取文件','File unavailable'):tr('文件缺失','File missing'));
				changeComparison(detail,[{label:tr('文件内容','File content'),before,after:file.after,code:true,
					afterLabel:applies?undefined:tr('模板候选内容','Template candidate')}]);
			}
		}
		if(plan.canApply)changeActions(preview.contentEl,[{label:tr('应用受管文件更新','Apply managed file updates'),primary:true,run:async()=>{
			const normalize=(text:string)=>text.replace(/^\uFEFF/u,'').replace(/\r\n/gu,'\n');
			const checkEditors=(path:string,expected:string|undefined)=>plugin.app.workspace.iterateAllLeaves(leaf=>{
				const view=leaf.view;
				if(view instanceof MarkdownView && view.file?.path===path &&
					(expected===undefined || normalize(view.editor.getValue())!==normalize(expected))){
					throw new Error(tr('请先保存正在编辑的文件，再预览。','Save the open file and preview again.')+' · '+path);
				}
			});
			await plugin.exclusive(library.location,()=>applyTemplateUpdate(plugin.disk,plugin.config,plan,host,checkEditors));
			await plugin.refresh();
			preview.close();
			dialog.close();
		}}]);
		preview.open();
	}).setCta();
	dialog.open();
}
