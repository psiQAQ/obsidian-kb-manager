import { TFile } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { requireIdentity } from '../git/identity.ts';
import { initialIdentityDefaults } from '../git/initial.ts';
import type { InitialIdentity, InitialPreview } from '../git/initial.ts';
import { defaultInitialBranch, defaultInitialMessage } from '../git/initial-options.ts';
import { createLibrary, CreationInterrupted, previewCreate, resumeCreation, reviewInterruptedCreation } from '../kb/create.ts';
import { kepanoSource } from '../kb/template.ts';
import { readVaultRegistry } from '../registry/desktop.ts';
import { libraryDestination, registryDataPath } from '../registry/paths.ts';
import { tr } from '../i18n.ts';
import { assertGitEnabled } from './device.ts';
import { V3Dialog, dialogContents } from './dialog.ts';
import { reviewCreationExclusions, showExclusionPlan } from './template-filter.ts';
import type {ApprovedExclusions} from './template-filter.ts';
import { reviewRegistryProtection } from './registry-ignore.ts';
import { destinationParentField } from './registry-path-field.ts';
import { choiceForSource, renderTemplatePicker, showTemplateDetails, templateChoices } from './v3-template-catalog.ts';
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

function pathList(parent:HTMLElement,title:string,paths:string[]){
	if(!paths.length)return;
	const detail=parent.createEl('details',{cls:'kb-v3-detail'});
	detail.createEl('summary',{text:`${title} (${paths.length})`});
	const list=detail.createEl('ul');
	for(const item of paths)list.createEl('li',{text:item});
}

function showInitialPlan(parent:HTMLElement,git:InitialPreview,head=''){
	if(git.identity.email.value.toLowerCase().endsWith('@users.invalid'))parent.createEl('p',{text:tr(
		'首提交将使用占位邮箱 '+git.identity.email.value+'。如需关联到 GitHub 账号，请填写已验证邮箱或你自己的 GitHub noreply 地址。',
		'The initial commit will use the placeholder email '+git.identity.email.value+'. To link it to your GitHub account, use a verified email or your own GitHub noreply address.')});
	const detail=parent.createEl('details',{cls:'kb-v3-detail'});
	detail.createEl('summary',{text:tr('Git 首提交详情','Initial Git commit details')});
	dialogContents(detail).facts([[tr('分支','Branch'),git.branch+(head?' · '+head.slice(0,7):'')],
		[tr('提交说明','Commit message'),git.message],...signatureFacts(git.identity),
		[tr('姓名来源','Name source'),identitySource(git.identity.name)],
		[tr('邮箱来源','Email source'),identitySource(git.identity.email)],['origin',git.origin||tr('未设置','Unset')]]);
	if(git.origin)detail.createEl('p',{text:tr('创建时将把远端地址保存在本地 Git 配置。','Creation saves the remote address in local Git configuration.')});
	pathList(detail,tr('首提交包含的文件','Files in the initial commit'),git.staged);
	pathList(detail,tr('复制到库内并由 Git 忽略','Copied into the library and ignored by Git'),git.ignored);
}

export async function createWizard(plugin:KnowledgeBaseManager,refresh:()=>Promise<void>,source?:string){
	assertGitEnabled(plugin);
	const {config,disk}=plugin;
	const [templates,defaults,initial]=await Promise.all([
		templateChoices(plugin),initialIdentityDefaults(),source===undefined?undefined:choiceForSource(plugin,source),
	]);
	if(initial?.invalid)throw new Error(initial.invalid);
	const values={name:defaults.name.value,email:defaults.email.value};
	const gitOptions={branch:defaultInitialBranch,message:defaultInitialMessage};
	let origin='';
	let template=initial,parent:string|null=null;
	let reviewedExclusions:{source:string; location:string; folders:readonly string[]}|undefined;
	const input={name:'',displayName:'',description:''};
	const wizard=new V3Dialog(plugin.app,tr('新建知识库','Create knowledge base'));
	wizard.modalEl.addClass('kb-create-wizard');
	const frame=wizard.contentEl.createDiv();
	const progress=frame.createEl('ol',{cls:'kb-wizard-steps',attr:{role:'list','aria-label':tr('创建步骤','Creation steps')}});
	const steps=[tr('模板','Template'),tr('详情','Details'),tr('确认','Confirm')].map((label,index)=>{
		const step=progress.createEl('li',{attr:{tabindex:'-1'}});
		step.createSpan({cls:'kb-wizard-step-number',text:String(index+1)});
		step.createSpan({text:label});
		return step;
	});
	const pages=frame.createDiv();
	const newPage=()=>pages.ownerDocument.createDocumentFragment().createEl('fieldset');
	const templatePage=newPage(),detailsPage=newPage();
	detailsPage.addClass('kb-wizard-fields');
	const details=dialogContents(detailsPage);
	const templateSummary=detailsPage.createEl('p',{cls:'kb-v3-muted'});
	const location=detailsPage.createEl('p',{cls:'kb-wizard-destination'});
	const locationLabel=location.createSpan({text:tr('Vault 内位置','Location in vault')});
	const destination=location.createEl('output',{attr:{'aria-label':locationLabel.textContent??''}});
	const updateDestination=()=>{
		if(parent===null || !input.name){
			destination.setText(tr('选择父目录并填写目录名','Choose a parent and enter a folder name'));
			return;
		}
		try { destination.setText(libraryDestination(parent,input.name)+'/'); }
		catch { destination.setText(tr('请检查目录名','Check the folder name')); }
	};
	const getParent=destinationParentField(details,plugin.app,config,disk.registry,{
		allowNew:true,compact:true,title:tr('选择新知识库的父目录','Choose the parent folder for the new library'),
		onSelect:value=>{parent=value;updateDestination();},
	});
	details.text(tr('目录名（必填）','Folder name (required)'),'',v=>{input.name=v;updateDestination();},{example:'research-notes'});
	details.text(tr('显示名（默认使用目录名）','Display name (defaults to folder name)'),'',v=>{input.displayName=v;},{example:tr('研究笔记','Research notes')});
	details.multiline(tr('简介（可选）','Description (optional)'),'',v=>{input.description=v;},{example:tr('整理研究笔记和参考资料。','Collect research notes and references.')});
	let identityRequired=false;
	try { requireIdentity(values); } catch { identityRequired=true; }
	const advanced=detailsPage.createEl('details',{cls:'kb-v3-detail'});
	const advancedSummary=advanced.createEl('summary');
	advancedSummary.createSpan({text:tr('高级 Git 选项','Advanced Git options')});
	const identitySummary=advancedSummary.createSpan({cls:'kb-wizard-git-identity kb-v3-muted'});
	const effectiveIdentity=()=>({name:values.name.trim()||defaults.name.value,email:values.email.trim()||defaults.email.value});
	const showIdentity=()=>{
		try {
			const {name,email}=requireIdentity(effectiveIdentity());
			identitySummary.setText(name+' <'+email+'>');
			identitySummary.hidden=false;
		} catch { identitySummary.hidden=true; }
	};
	const addIdentityFields=(body:ReturnType<typeof dialogContents>)=>{
		body.text(tr('Git 姓名','Git name'),values.name,v=>{values.name=v;showIdentity();});
		body.text(tr('Git 邮箱','Git email'),values.email,v=>{values.email=v;showIdentity();});
	};
	if(identityRequired){
		detailsPage.createEl('p',{text:tr('请为首提交填写有效的 Git 姓名和邮箱。','Enter a valid Git name and email for the initial commit.')});
		addIdentityFields(details);
	}
	detailsPage.appendChild(advanced);
	const gitFields=dialogContents(advanced);
	if(!identityRequired)addIdentityFields(gitFields);
	showIdentity();
	gitFields.text(tr('初始分支','Initial branch'),gitOptions.branch,v=>{gitOptions.branch=v;});
	gitFields.text(tr('首提交说明（单行）','Initial commit message (one line)'),gitOptions.message,v=>{gitOptions.message=v;});
	gitFields.text(tr('origin（可选，HTTPS 或 SSH）','Origin (optional, HTTPS or SSH)'),'',v=>{origin=v;});

	function showStep(index:number,page:HTMLElement,focus=true){
		pages.replaceChildren(page);
		for(const [position,step] of steps.entries()){
			if(position===index)step.setAttribute('aria-current','step');
			else step.removeAttribute('aria-current');
		}
		wizard.contentEl.scrollTop=0;
		if(focus)steps[index]?.focus();
	}
	function showOutcome(title:string,page:HTMLElement){
		if(!wizard.contentEl.contains(frame))wizard.contentEl.appendChild(frame);
		wizard.setTitle(title);
		progress.hidden=true;
		pages.replaceChildren(page);
		wizard.contentEl.scrollTop=0;
		if(!wizard.containerEl.isConnected)wizard.open();
		wizard.titleEl.tabIndex=-1;
		wizard.titleEl.focus();
	}
	function setTemplate(choice:TemplateChoice){
		template=choice;
		templateSummary.setText(tr('模板','Template')+' · '+choice.name);
	}
	function actions(page:HTMLElement){ return dialogContents(page.createDiv({cls:'kb-wizard-actions'})); }
	renderTemplatePicker(templatePage,templates,value=>{
		setTemplate(value);
		showStep(1,detailsPage);
		return Promise.resolve();
	},initial);
	updateDestination();

	const run=async(chosen:TemplateChoice,exclusions:ApprovedExclusions,action:()=>ReturnType<typeof createLibrary>)=>{
		let result:Awaited<ReturnType<typeof createLibrary>>;
		try{result=await action();}
		catch(error){
			if(!(error instanceof CreationInterrupted))throw error;
			const recoveryPage=newPage(), recovery=dialogContents(recoveryPage);
			recovery.lines([error.receipt.path,error.message]);
			actions(recoveryPage).action(tr('复核并继续','Review and continue'),async()=>{
				const {receipt}=error,review=await reviewInterruptedCreation(disk,receipt);
				const recoveryReview=newPage(), next=dialogContents(recoveryReview);
				next.lines([receipt.path]);
				showInitialPlan(recoveryReview,review.git,review.head);
				const registry=await reviewRegistryProtection(plugin,next);
				showExclusionPlan(next,exclusions.plan);
				const protect=async()=>{await registry();await exclusions.apply(receipt.manifest.id);};
				actions(recoveryReview).action(review.head?tr('登记','Register'):tr('提交并登记','Commit and register'),()=>run(chosen,exclusions,
					()=>plugin.exclusiveGit(receipt.preview.location,()=>resumeCreation(disk,plugin.config,receipt,review,protect)))).setCta();
				showOutcome(review.head?tr('确认现有首提交并登记','Confirm existing initial commit and register'):
					tr('确认目标目录中的首提交','Confirm initial commit at the destination'),recoveryReview);
			}).setCta();
			showOutcome(tr('继续创建知识库','Continue library creation'),recoveryPage);
			return;
		}
		const completed=newPage(), success=dialogContents(completed);
		success.facts([[tr('知识库路径','Library path'),result.path],[tr('分支与提交','Branch and commit'),result.branch+' · '+result.head.slice(0,7)],
			[tr('提交说明','Commit message'),result.message],...signatureFacts(result.identity),['origin',result.origin||tr('未设置','Unset')]]);
		const entry=chosen.entry,done=actions(completed);
		if(entry)done.action(tr('打开首页','Open home note'),async()=>{
			const relative=result.location+'/'+entry;
			await disk.path(relative);
			const file=plugin.app.vault.getAbstractFileByPath(relative);
			if(!(file instanceof TFile))throw new Error(tr('Obsidian 正在索引首页，请稍后重试。','Obsidian is indexing the home note. Try again shortly.'));
			await plugin.app.workspace.getLeaf(false).openFile(file);
			wizard.close();
		}).setCta();
		done.action(tr('完成','Done'),()=>{wizard.close();return Promise.resolve();});
		showOutcome(tr('知识库已创建','Library created'),completed);
		await refresh();
	};
	const detailActions=actions(detailsPage);
	detailActions.action(tr('返回模板','Back to template'),()=>{showStep(0,templatePage);return Promise.resolve();});
	detailActions.action(tr('预览','Preview'),async()=>{
		if(!template)return;
		assertGitEnabled(plugin);
		const chosen=template;
		const requested={...input,source:chosen.source,parent:getParent(),displayName:input.displayName||input.name,
			git:{defaults,values:{...values},origin,...gitOptions}};
		try { requireIdentity(effectiveIdentity()); }
		catch(error) { if(!identityRequired)advanced.open=true; throw error; }
		detailsPage.disabled=true;
		try {
			await readVaultRegistry(disk);
			const skeleton=chosen.source===kepanoSource?plugin.kepanoSkeleton:plugin.skeleton;
			const preview=await previewCreate(disk,plugin.config,requested,skeleton);
			const confirmPage=newPage(),confirm=dialogContents(confirmPage);
			confirm.facts([[tr('Vault 内位置','Location in vault'),preview.location+'/'],
				[tr('模板','Template'),chosen.name+' · '+preview.template.version],
				[tr('显示名','Display name'),preview.input.displayName]]);
			confirmPage.createEl('p',{text:tr('创建目录，为模板文件建立本地 Git 首提交，并登记知识库。',
				'Create the folder, commit the template files to local Git, and register the library.')});
			if(preview.warnings.length)confirm.lines(preview.warnings);
			showInitialPlan(confirmPage,preview.git);
			const details=confirmPage.createEl('details',{cls:'kb-v3-detail'});
			details.createEl('summary',{text:tr('模板与登记详情','Template and registry details')});
			showTemplateDetails(details,chosen);
			dialogContents(details).facts([[tr('通用检验套件','Common check kit'),preview.checkKit.version],
				[tr('Vault 知识库登记','Vault library registry'),registryDataPath(disk.configDir)]]);
			pathList(details,tr('创建目录','Folders to create'),preview.template.folders.map(folder=>folder+'/'));
			pathList(details,tr('跳过的模板路径','Skipped template paths'),preview.template.excluded);
			const registry=await reviewRegistryProtection(plugin,confirm);
			const previous=reviewedExclusions?.source===chosen.source && reviewedExclusions.location===preview.location?reviewedExclusions.folders:undefined;
			const exclusionControls=dialogContents(confirmPage.createDiv({cls:'kb-wizard-exclusions'}));
			const selection=await reviewCreationExclusions(plugin.app,disk.registry,exclusionControls,
				preview.location,preview.template.suggestedExcludedFolders??[],previous);
			const confirmActions=actions(confirmPage);
			confirmActions.action(tr('返回详情','Back to details'),()=>{
				reviewedExclusions={source:chosen.source,location:preview.location,folders:selection.read().plan.folders};
				showStep(1,detailsPage);
				return Promise.resolve();
			});
			confirmActions.action(tr('创建知识库','Create library'),async()=>{
				const exclusions=selection.read();
				confirmPage.disabled=true;
				try {
					await run(chosen,exclusions,()=>plugin.exclusiveGit(preview.location,async()=>{
						await exclusions.check();
						return createLibrary(disk,plugin.config,preview,skeleton,async manifest=>{
							await registry();await exclusions.apply(manifest.id);
						},exclusions.plan.folders);
					}));
				} finally { confirmPage.disabled=false; }
			}).setCta();
			if(detailsPage.isConnected)showStep(2,confirmPage);
		} finally { detailsPage.disabled=false; }
	}).setCta();
	if(initial)setTemplate(initial);
	showStep(initial?1:0,initial?detailsPage:templatePage,false);
	wizard.open();
}
