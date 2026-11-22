import { MarkdownView, Setting } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import type { Library } from '../kb/catalog.ts';
import { applyTemplateUpdate, previewTemplateUpdate } from '../kb/template-update.ts';
import { templateHost } from '../kb/template-requirements.ts';
import { tr } from '../i18n.ts';
import { V3Dialog } from './dialog.ts';
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
	new Setting(dialog.contentEl).setName(tr('模板目录','Template folder')).addDropdown(input=>{
		for(const candidate of candidates)input.addOption(candidate.source,candidate.source);
		input.setValue(source).onChange(value=>{source=value;});
	});
	dialog.action(tr('预览更新','Preview update'),async()=>{
		const host=templateHost(plugin.app,plugin.manifest.version);
		const plan=await previewTemplateUpdate(plugin.disk,plugin.config,library,source,host);
		const preview=new V3Dialog(plugin.app,tr('受管模板文件更新预览','Preview managed template file updates'),owner);
		preview.facts([
			[tr('知识库','Library'),library.location],
			[tr('模板目录','Template folder'),source],
			[tr('记录版本与目标版本','Recorded and target releases'),plan.installedVersion+' → '+plan.targetVersion],
		]);
		if(plan.blockers.length)preview.lines(plan.blockers);
		if(plan.optional.length)preview.lines(plan.optional);
		if(plan.pending)preview.lines([tr('冲突、缺失和无法读取的文件保留原状。处理后可以再次预览。','Conflicting, missing and unavailable files keep their current state. Review them and preview again.')]);
		const labels={
			current:tr('已是目标内容','Current'),add:tr('添加','Add'),replace:tr('替换','Replace'),conflict:tr('冲突','Conflict'),
			missing:tr('已缺失','Missing'),retained:tr('保留','Retained'),unavailable:tr('不可用','Unavailable'),
		};
		if(!plan.files.length)preview.lines([tr('当前版本未声明受管文件。','This release declares no managed files.')]);
		for(const file of plan.files){
			const detail=preview.contentEl.createEl('details',{cls:'kb-v3-detail'});
			detail.createEl('summary',{text:labels[file.change]+' · '+file.path});
			if(file.reason)detail.createEl('p',{text:file.reason});
			if(file.change==='retained')detail.createEl('p',{text:tr('目标版本取消了对此文件的管理。','The target release no longer manages this file.')});
			if(file.before!==undefined && file.change!=='current'){
				detail.createEl('p',{text:tr('目标库内容','Library content')});
				detail.createEl('pre',{cls:'kb-v3-code',text:file.before});
			}
			if(file.after!==undefined && file.change!=='current'){
				detail.createEl('p',{text:tr('模板版本内容','Template release content')});
				detail.createEl('pre',{cls:'kb-v3-code',text:file.after});
			}
		}
		if(plan.canApply)preview.action(tr('应用受管文件更新','Apply managed file updates'),async()=>{
			const normalize=(text:string)=>text.replace(/^\uFEFF/u,'').replace(/\r\n/gu,'\n');
			const checkEditors=(path:string,expected:string|undefined)=>plugin.app.workspace.iterateAllLeaves(leaf=>{
				const view=leaf.view;
				if(view instanceof MarkdownView && view.file?.path===path &&
					(expected===undefined || normalize(view.editor.getValue())!==normalize(expected))){
					throw new Error(tr('请先保存正在编辑的文件，再预览。','Save the open file and preview again.')+' · '+path);
				}
			});
			await plugin.exclusive(library.location,()=>applyTemplateUpdate(plugin.disk,plugin.config,plan,host,checkEditors));
			preview.close();
			dialog.close();
			await plugin.refresh();
		}).setCta();
		preview.open();
	}).setCta();
	dialog.open();
}
