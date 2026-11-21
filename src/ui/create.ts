import { TFile } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { initialIdentityDefaults } from '../git/initial.ts';
import type { InitialIdentity, InitialPreview } from '../git/initial.ts';
import { defaultInitialBranch, defaultInitialMessage } from '../git/initial-options.ts';
import { createLibrary, CreationInterrupted, previewCreate, resumeCreation, reviewInterruptedCreation } from '../kb/create.ts';
import { kepanoSource } from '../kb/template.ts';
import { readVaultRegistry } from '../registry/desktop.ts';
import { registryDataPath } from '../registry/paths.ts';
import { tr } from '../i18n.ts';
import { assertGitEnabled } from './device.ts';
import { Dialog, V3Dialog } from './dialog.ts';
import { reviewCreationExclusions, showExclusionPlan } from './template-filter.ts';
import type {ApprovedExclusions} from './template-filter.ts';
import { reviewRegistryProtection } from './registry-ignore.ts';
import { destinationParentField } from './registry-path-field.ts';
import { choiceForSource, pickTemplate, showTemplateDetails } from './v3-template-catalog.ts';
import type { TemplateChoice } from './v3-template-catalog.ts';

function identitySource(field:InitialIdentity['name']){
	const sources={
		global:tr('继承 Git 全局配置','Inherited from global Git configuration'),
		login:tr('系统登录名，写入库内配置','OS login, saved to this repository'),
		environment:tr('环境变量，写入库内配置','Environment variable, saved to this repository'),
		placeholder:tr('占位邮箱，写入库内配置','Placeholder email, saved to this repository'),
		local:tr('已编辑，写入库内配置','Edited, saved to this repository'),
	};
	return sources[field.source]+(field.origin?' · '+field.origin:'');
}

function signatureFacts(identity:InitialIdentity){
	const signature=identity.name.value+' <'+identity.email.value+'>';
	return [[tr('作者','Author'),signature],[tr('提交者','Committer'),signature]] as const;
}

function pathList(dialog:Dialog,title:string,paths:string[]){
	if(!paths.length)return;
	const detail=dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
	detail.createEl('summary',{text:`${title} (${paths.length})`});
	const list=detail.createEl('ul');
	for(const item of paths)list.createEl('li',{text:item});
}

function showInitialPlan(dialog:Dialog,git:InitialPreview,head=''){
	dialog.facts([[tr('分支','Branch'),git.branch+(head?' · '+head.slice(0,7):'')],
		[tr('提交说明','Commit message'),git.message],...signatureFacts(git.identity),
		[tr('姓名来源','Name source'),identitySource(git.identity.name)],
		[tr('邮箱来源','Email source'),identitySource(git.identity.email)],['origin',git.origin||tr('未设置','Unset')]]);
	if(git.origin)dialog.contentEl.createEl('p',{text:tr('仅保存远端地址。创建过程不会联网或设置上游分支。','Creation saves the remote address locally, without connecting or setting an upstream branch.')});
	if(git.identity.email.value.toLowerCase().endsWith('@users.invalid'))dialog.contentEl.createEl('p',{text:tr(
		'占位邮箱无法收信，也不会将首提交关联到 GitHub 账号。若需关联到你的账号，请填写已验证的邮箱或你自己的 GitHub noreply 地址。',
		'The placeholder email cannot receive mail or link the initial commit to your GitHub account. Use a verified email or your own GitHub noreply address to link it to your account.')});
	pathList(dialog,tr('首提交包含的文件','Files in the initial commit'),git.staged);
	pathList(dialog,tr('复制到库内并由 Git 忽略','Copied into the library and ignored by Git'),git.ignored);
}

export async function createWizard(plugin:KnowledgeBaseManager,refresh:()=>Promise<void>,source?:string){
	assertGitEnabled(plugin);
	if(source!==undefined){
		const chosen=await choiceForSource(plugin,source);
		if(chosen.invalid)throw new Error(chosen.invalid);
		await createForm(plugin,refresh,chosen);
		return;
	}
	await pickTemplate(plugin,template=>createForm(plugin,refresh,template));
}

async function createForm(plugin:KnowledgeBaseManager,refresh:()=>Promise<void>,initial:TemplateChoice){
	const {config,disk}=plugin;
	const defaults=await initialIdentityDefaults();
	const values={name:defaults.name.value,email:defaults.email.value};
	const gitOptions={branch:defaultInitialBranch,message:defaultInitialMessage};
	let origin='';
	let template=initial;
	const input={name:'',displayName:'',description:'',source:template.source};
	const form=new V3Dialog(plugin.app,tr('新建知识库','Create knowledge base'));
	const summary=form.contentEl.createEl('details',{cls:'kb-v3-detail'});
	const chosen=summary.createEl('summary',{text:template.name});
	const facts=summary.createDiv();
	showTemplateDetails(facts,template);
	form.action(tr('更换模板','Change template'),()=>pickTemplate(plugin,value=>{
		template=value;
		input.source=value.source;
		chosen.setText(value.name);
		facts.empty();
		showTemplateDetails(facts,template);
		return Promise.resolve();
	},template));
	const getParent=destinationParentField(form,plugin.app,config,disk.registry,true);
	form.text(tr('物理目录名','Folder name'),'',v=>{input.name=v;},{example:'research-notes'});
	form.text(tr('显示名（默认使用目录名）','Display name (defaults to folder name)'),'',v=>{input.displayName=v;},{example:tr('研究笔记','Research notes')});
	form.multiline(tr('简介','Description'),'',v=>{input.description=v;},{example:tr('整理研究笔记和参考资料。','Collect research notes and references.')});
	form.text(tr('Git 姓名','Git name'),values.name,v=>{values.name=v;});
	form.text(tr('Git 邮箱','Git email'),values.email,v=>{values.email=v;});
	form.text(tr('初始分支','Initial branch'),gitOptions.branch,v=>{gitOptions.branch=v;});
	form.text(tr('首提交说明（单行）','Initial commit message (one line)'),gitOptions.message,v=>{gitOptions.message=v;});
	form.text(tr('origin（可选，HTTPS 或 SSH）','Origin (optional, HTTPS or SSH)'),'',v=>{origin=v;});
	const run=async(dialog:Dialog,exclusions:ApprovedExclusions,action:()=>ReturnType<typeof createLibrary>)=>{
		let result:Awaited<ReturnType<typeof createLibrary>>;
		try{result=await action();}
		catch(error){
			if(!(error instanceof CreationInterrupted))throw error;
			dialog.close();form.close();
			const recovery=new Dialog(plugin.app,tr('继续创建知识库','Continue library creation'));
			recovery.lines([error.receipt.path,error.message]);
			recovery.action(tr('复核并继续','Review and continue'),async()=>{
				const {receipt}=error,review=await reviewInterruptedCreation(disk,receipt);
				const next=new Dialog(plugin.app,review.head?tr('确认现有首提交并登记','Confirm existing initial commit and register'):tr('确认目标目录中的首提交','Confirm initial commit at the destination'));
				next.lines([receipt.path]);
				showInitialPlan(next,review.git,review.head);
				const registry=await reviewRegistryProtection(plugin,next);
				showExclusionPlan(next,exclusions.plan);
				const protect=async()=>{await registry();await exclusions.apply(receipt.manifest.id);};
				next.action(review.head?tr('登记','Register'):tr('提交并登记','Commit and register'),()=>run(next,exclusions,
					()=>plugin.exclusiveGit(receipt.preview.location,()=>resumeCreation(disk,plugin.config,receipt,review,protect))));
				recovery.close();next.open();
			});
			recovery.open();return;
		}
		dialog.close();form.close();
		const success=new Dialog(plugin.app,tr('知识库已创建','Library created'));
		success.facts([[tr('知识库路径','Library path'),result.path],[tr('分支与提交','Branch and commit'),result.branch+' · '+result.head.slice(0,7)],
			[tr('提交说明','Commit message'),result.message],...signatureFacts(result.identity),['origin',result.origin||tr('未设置','Unset')]]);
		if(template.entry)success.action(tr('打开首页','Open home note'),async()=>{
		const relative=result.location+'/'+template.entry;
			await disk.path(relative);
			const file=plugin.app.vault.getAbstractFileByPath(relative);
			if(!(file instanceof TFile))throw new Error(tr('Obsidian 正在索引首页，请稍后重试。','Obsidian is indexing the home note. Try again shortly.'));
			await plugin.app.workspace.getLeaf(false).openFile(file);
			success.close();
		}).setCta();
		success.action(tr('完成','Done'),async()=>{success.close();});
		success.open();
		await refresh();
	};
	form.action(tr('预览','Preview'),async()=>{
		assertGitEnabled(plugin);
		await readVaultRegistry(disk);
		const skeleton=input.source===kepanoSource?plugin.kepanoSkeleton:plugin.skeleton;
		const preview=await previewCreate(disk,plugin.config,{...input,parent:getParent(),displayName:input.displayName||input.name,
			git:{defaults,values:{...values},origin,...gitOptions}},skeleton);
		const {git}=preview;
		const confirm=new V3Dialog(plugin.app,tr('确认创建','Confirm creation'));
		confirm.facts([[tr('知识库路径','Library path'),preview.location],[tr('模板','Template'),template.name+' · '+preview.template.version]]);
		showTemplateDetails(confirm.contentEl,template);
		if(preview.warnings.length)confirm.lines(preview.warnings);
		showInitialPlan(confirm,git);
		if(preview.template.folders.length)pathList(confirm,tr('创建目录','Folders to create'),preview.template.folders.map(folder=>folder+'/'));
		if(preview.template.excluded.length)pathList(confirm,tr('跳过的模板路径','Skipped template paths'),preview.template.excluded);
		confirm.lines([tr('更新 Vault 知识库登记','Update the Vault library registry')+' · '+registryDataPath(disk.configDir)]);
		const registry=await reviewRegistryProtection(plugin,confirm);
		const selection=await reviewCreationExclusions(plugin.app,disk.registry,confirm,preview.location,preview.template.suggestedExcludedFolders??[]);
		confirm.action(tr('创建','Create'),()=>{
			const exclusions=selection.read();
			return run(confirm,exclusions,()=>plugin.exclusiveGit(preview.location,async()=>{
				await exclusions.check();
				return createLibrary(disk,plugin.config,preview,skeleton,async manifest=>{
					await registry();await exclusions.apply(manifest.id);
				},exclusions.plan.folders);
			}));
		}).setCta();
		confirm.open();
	}).setCta();
	form.open();
}
