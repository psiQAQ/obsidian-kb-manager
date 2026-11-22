import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Notice, Setting } from 'obsidian';
import { renameNewDirectory } from '../fs/publish.ts';
import { statIfPresent } from '../fs/vault.ts';
import { validateFolderSettings } from '../registry/paths.ts';
import { tr } from '../i18n.ts';
import { builtinPacks } from '../kb/template-pack.ts';
import { declaration, folderTemplate } from '../kb/template.ts';
import type KnowledgeBaseManager from '../main.ts';
import { createWizard } from './create.ts';
import { V3Dialog, dialogContents } from './dialog.ts';
import { purposeLabels } from './v3-template-catalog.ts';

const exampleCheck=`export default async function check({notes}) {
  const home = notes.find(note => note.path === 'README.md');
  return home?.body.includes('## ') ? [] : [{
    code: 'example-missing-section', severity: 'warning', file: 'README.md',
    message: 'Add a second-level heading to the home note.',
  }];
}
`;

async function targetFor(plugin:KnowledgeBaseManager,source:string) {
	validateFolderSettings([],[...plugin.config.templates,source],plugin.disk.configDir);
	const target=await plugin.disk.path(source);
	if(await statIfPresent(target))throw new Error(tr('选择尚不存在的模板目录。','Choose a new template folder.')+' · '+source);
	if(!(await statIfPresent(dirname(target)))?.isDirectory())throw new Error(tr('请先建立模板的父目录。','Create the template parent folder first.'));
	for(const part of ['',...source.split('/').slice(0,-1).map((_,index,parts)=>parts.slice(0,index+1).join('/'))]){
		const folder=await plugin.disk.folder(part);
		for(const marker of ['kb.toml','kb-manager.json']){
			if(await statIfPresent(join(folder,marker)))throw new Error(tr('选择知识库之外的模板目录。','Choose a template folder outside existing libraries.')+' · '+(part||'/'));
		}
	}
	return target;
}

export function makeTemplateWizard(plugin:KnowledgeBaseManager,onRegistered:(source:string)=>void) {
	const dialog=new V3Dialog(plugin.app,tr('制作模板','Make a template'));
	const labels=purposeLabels();
	const draft={source:'',id:'',name:'',description:'',purpose:'starter',example:false};
	dialog.contentEl.createEl('p',{text:tr('创建一个可编辑的模板目录，登记后可从“我的模板”新建知识库。',
		'Create an editable template folder that appears under My templates when you create a library.')});
	dialog.text(tr('模板目录（仓库相对路径）','Template folder (vault-relative)'),'',v=>{draft.source=v;},{example:'my-template'});
	dialog.text(tr('模板 ID（小写英文及连字符）','Template ID (lowercase and hyphens)'),'',v=>{draft.id=v;},{example:'my-template'});
	dialog.text(tr('显示名','Display name'),'',v=>{draft.name=v;},{example:tr('我的模板','My template')});
	dialog.multiline(tr('简介','Description'),'',v=>{draft.description=v;});
	dialog.choice(tr('用途','Use case'),labels,v=>{draft.purpose=v;});
	new Setting(dialog.contentEl).setName(tr('附带专项检验示例','Include a sample check')).addToggle(toggle=>{
		toggle.toggleEl.setAttribute('aria-label',tr('附带专项检验示例','Include a sample check'));
		toggle.onChange(value=>{draft.example=value;});
	});
	dialog.action(tr('预检与预览','Validate and preview'),async()=>{
		const {example,purpose}=draft;
		const source=draft.source.trim(),id=draft.id.trim(),name=draft.name.trim(),description=draft.description.trim();
		if(!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id) || builtinPacks().some(pack=>pack.id===id))throw new Error(tr('输入未被内置模板使用的小写模板 ID。','Enter a lowercase ID distinct from built-in template IDs.'));
		if(!name || !description)throw new Error(tr('填写模板显示名和简介。','Enter a display name and description.'));
		const target=await targetFor(plugin,source);
		const spec={id,version:'1',name,description,purpose,entry:'README.md',pageTemplates:['Templates'],suggestedExcludedFolders:['Templates'],text:{'README.md':['kb_name','description']},
			...(example?{checks:[{id:'example-home-section',name:tr('首页章节','Home note section'),description:tr('检查首页是否含二级标题。','Check for a second-level heading in the home note.'),path:'checks/home-section.mjs'}]}:{})};
		const raw=JSON.stringify(spec,null,2)+'\n';
		declaration(raw);
		const files={
			'kb-template.json':raw,
			'README.md':'# {{kb_name}}\n\n{{description}}\n\n## '+tr('开始使用','Get started')+'\n\n'+tr('在本库中创建一条笔记，从页面模板开始。','Create a note in this library and insert the page template.')+'\n',
			'Templates/Note.md':'# {{title}}\n\n'+tr('创建日期','Created')+' · {{date}}\n',
			...(example?{'checks/home-section.mjs':exampleCheck}:{}),
		};
		const preview=new V3Dialog(plugin.app,tr('确认制作模板','Confirm template creation'));
		preview.facts([[tr('模板目录','Template folder'),source+'/'],[tr('显示名','Display name'),name],
			[tr('模板 ID','Template ID'),id],[tr('用途','Use case'),labels[purpose as keyof typeof labels]]]);
		preview.contentEl.createEl('p',{text:tr('将以下文件写入模板目录，并将它加入“我的模板”。',
			'Write these files to the template folder and add it to My templates.')});
		preview.lines(Object.keys(files));
		if(example)preview.contentEl.createEl('p',{text:tr('运行示例检查时须单独信任其代码。','Trust the sample check separately before running it.')});
		const config=preview.contentEl.createEl('details',{cls:'kb-v3-detail'});
		config.createEl('summary',{text:'kb-template.json'});
		config.createEl('pre').createEl('code',{text:raw});
		const actions=dialogContents(preview.contentEl.createDiv({cls:'kb-wizard-actions'}));
		const back=actions.action(tr('返回编辑','Back to editing'),()=>{preview.close();return Promise.resolve();});
		actions.action(tr('制作并登记','Make and register'),async()=>{
			back.setDisabled(true);
			await plugin.exclusive(source,async()=>{
				if(await targetFor(plugin,source)!==target)throw new Error(tr('模板目标已变化，请重新预检。','The template destination changed. Validate again.'));
				const staged=await mkdtemp(join(dirname(target),'.kb-template-'));
				try {
					for(const [relative,content] of Object.entries(files)){
						const file=join(staged,relative);
						await mkdir(dirname(file),{recursive:true});
						await writeFile(file,content,{flag:'wx'});
					}
					await folderTemplate(staged,plugin.disk.configDir,{displayName:name,description,destination:'example'});
					await targetFor(plugin,source);
					await renameNewDirectory(staged,target);
				} finally {await rm(staged,{recursive:true,force:true});}
				plugin.config.templates=[...plugin.config.templates,source];
				try { await plugin.persist(); }
				catch(error) {
					plugin.config.templates=plugin.config.templates.filter(value=>value!==source);
					throw new Error(tr('模板文件已保存。请从设置登记模板目录。','Template files are saved. Register the folder in settings.')+' · '+source+' · '+String(error));
				}
			}).finally(()=>back.setDisabled(false));
			preview.close();dialog.close();
			const done=new V3Dialog(plugin.app,tr('模板已登记','Template registered'));
			done.facts([[tr('模板目录','Template folder'),source]]);
			done.contentEl.createEl('p',{text:tr('可用此模板预览新库，确认后会在仓库中创建知识库。',
				'Preview a library from this template. Confirming creates a library in the vault.')});
			const doneActions=dialogContents(done.contentEl.createDiv({cls:'kb-wizard-actions'}));
			doneActions.action(tr('完成','Done'),()=>{done.close();return Promise.resolve();});
			doneActions.action(tr('用此模板新建知识库','Create a library from this template'),async()=>{await createWizard(plugin,()=>plugin.refresh(),source);done.close();}).setCta();
			done.open();
			onRegistered(source);
			try {await plugin.refresh();} catch(error) {new Notice(String(error));}
		}).setCta();
		preview.open();
	}).setCta();
	dialog.open();
}
