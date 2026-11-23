import {Setting} from 'obsidian';
import {builtinPacks,builtinSource} from '../kb/template-pack.ts';
import {checkCreationRequirements} from '../kb/template-core.ts';
import {templateHost} from '../kb/template-requirements.ts';
import {tr} from '../i18n.ts';
import {readManifest} from '../kb/identity-core.ts';
import {reviewCreationExclusions} from '../ui/template-filter.ts';
import type {ApprovedExclusions} from '../ui/template-filter.ts';
import {Dialog,dialogContents} from '../ui/dialog.ts';
import {changeActions,changeComparison,panelGroup} from '../ui/change-preview.ts';
import {creationDisplayName,unmatchedDiagnosticExclusionWarnings} from '../ui/creation-preview.ts';
import {destinationParentField} from '../ui/registry-path-field.ts';
import {builtinTemplateLabels,templateIdentityLabel} from '../ui/template-labels.ts';
import {libraryDestination} from '../registry/paths.ts';
import {createPreview,instantiate,MobileRegistrationInterrupted} from './catalog.ts';
import type {Library} from './catalog.ts';
import {defaultInitialBranch,defaultInitialMessage} from '../git/initial-options.ts';
import {bindingLines} from './bindings.ts';
import {decode} from './disk.ts';
import {branchName,configure,localAuthor,mobileStatus} from './git.ts';
import {download,secretKey,upstream} from './remote.ts';
import type {CloneChoice} from './remote.ts';
import {endpoint,mobileHttp} from './http.ts';
import {registryIgnoreLines} from './registration.ts';
import type MobilePlugin from './plugin.ts';

export function confirm(plugin:MobilePlugin,title:string,lines:string[],apply:()=>Promise<void>,close?:()=>void) {
	const modal=new Dialog(plugin.app,title);
	modal.lines(lines);
	modal.action(tr('确认','Confirm'),async()=>{await apply();modal.close();close?.();await plugin.refresh();});
	modal.open();
}
export function createForm(plugin:MobilePlugin) {
	const {ctx}=plugin,dlg=new Dialog(plugin.app,tr('新建知识库','Create knowledge base'));
	const input={name:'',displayName:'',description:'',source:'',author:plugin.deviceAuthor(),origin:'',
		branch:defaultInitialBranch,message:defaultInitialMessage};
	let reviewedExclusions:{source:string;location:string;folders:readonly string[]}|undefined;
	const getParent=destinationParentField(dlg,plugin.app,ctx,ctx.registry,true);
	dlg.text(tr('目录名（必填）','Folder name (required)'),'',v=>{input.name=v;},{example:'research-notes'});
	dlg.text(tr('显示名（默认使用目录名）','Display name (defaults to folder name)'),'',v=>{input.displayName=v;},{placeholder:tr('研究笔记','Research notes')});
	dlg.multiline(tr('简介（可选）','Description (optional)'),'',v=>{input.description=v;},{placeholder:tr('整理研究笔记和参考资料。','Collect research notes and references.')});
	const builtin=new Map(builtinPacks().map(pack=>[builtinSource(pack.id),builtinTemplateLabels(pack)]));
	const templates=Object.fromEntries([
		...Array.from(builtin,([source,pack])=>[source,pack.name] as const),
		...ctx.templates.map(source=>[source,source] as const),
	]);
	dlg.choice(tr('模板','Template'),templates,source=>{
		input.source=source;
		updateTemplateDescription();
	},input.source);
	const templateDescription=dlg.contentEl.createEl('p',{cls:'kb-v3-muted',attr:{role:'status'}});
	function updateTemplateDescription(){
		const description=builtin.get(input.source)?.description ?? '';
		templateDescription.hidden=!description;
		templateDescription.setText(description);
	}
	updateTemplateDescription();
	dlg.text(tr('提交姓名','Commit author name'),input.author.name,v=>{input.author.name=v;});
	dlg.text(tr('提交邮箱','Commit author email'),input.author.email,v=>{input.author.email=v;});
	dlg.text(tr('初始分支','Initial branch'),input.branch,v=>{input.branch=v;});
	dlg.text(tr('首提交说明（单行）','Initial commit message (one line)'),input.message,v=>{input.message=v;});
	dlg.text(tr('origin HTTPS 地址（可选）','origin HTTPS URL (optional)'),'',v=>{input.origin=v;});
	dlg.action(tr('预览','Preview'),async()=>{
		plugin.assertEnabled();
		const displayName=creationDisplayName(input.name,input.displayName);
		const requested={...input,parent:getParent(),displayName};
		const p=await createPreview(ctx,requested,plugin.templates);
		const host=templateHost(plugin.app,plugin.manifest.version);
		const optional=checkCreationRequirements(p.template,host);
		const review=new Dialog(plugin.app,tr('确认创建知识库','Confirm library creation'));
		const warnings=unmatchedDiagnosticExclusionWarnings(p.template);
		if(warnings.length)review.lines(warnings);
		if(optional.length)review.lines(optional.map(item=>tr('可选工作流 · ','Optional workflow · ')+item));
		const {author,origin,files,branch,message}=p.initial,tracked=files.map(file=>file.name),trackedSet=new Set(tracked);
		const signature=author.name+' <'+author.email+'>';
		review.facts([[tr('知识库路径','Library path'),p.location],[tr('模板','Template'),templates[requested.source] ?? templateIdentityLabel(p.template.id)],
			[tr('显示名','Display name'),p.input.displayName],[tr('通用检验套件','Common check kit'),p.checkKit.version],
			[tr('分支','Branch'),branch],[tr('提交说明','Commit message'),message],
			[tr('作者','Author'),signature],[tr('提交者','Committer'),signature],['origin',origin||tr('未设置','Unset')]]);
		review.lines([tr('姓名和邮箱将写入本库 Git 配置和提交历史。','The name and email will be saved in this library’s Git config and commit history.'),
			...(origin?[tr('创建时只保存远端地址。','Creation only saves the remote URL.')]:[]),...registryIgnoreLines(p.registryIgnore)]);
		review.contentEl.createEl('h3',{text:tr('初始提交文件','Files in the initial commit')});
		review.lines(tracked.length?tracked:[tr('所有文件均被忽略，将创建空的初始提交。','All files are ignored. The initial commit will be empty.')]);
		review.contentEl.createEl('h3',{text:tr('仅保存在本库的文件','Files kept in the library working tree')});
		review.lines([...new Set(['kb.toml',...p.template.files.map(file=>file.name)])].filter(file=>!trackedSet.has(file)));
		const {suggestedExcludedFolders=[],defaultExcludedFolders}=p.template;
		const previous=reviewedExclusions?.source===requested.source && reviewedExclusions.location===p.location?reviewedExclusions.folders:undefined;
		const selection=await reviewCreationExclusions(plugin.app,ctx.registry,review,p.location,suggestedExcludedFolders,
			previous??defaultExcludedFolders??suggestedExcludedFolders);
		review.setCloseCallback(()=>{reviewedExclusions={source:requested.source,location:p.location,folders:selection.read().plan.folders};});
		let pending:ApprovedExclusions|undefined;
		review.action(tr('创建并提交','Create and commit'),async()=>{
			plugin.assertEnabled();
			const exclusions=pending??selection.read();
			const result=await plugin.catalogWrite(async()=>{
				if(!pending)checkCreationRequirements(p.template,host);
				await exclusions.check(p.id);
				try{return await instantiate(plugin.ctx,p,plugin.templates,identity=>exclusions.apply(identity.id),exclusions.plan.folders);}
				catch(error){
					if(error instanceof MobileRegistrationInterrupted){pending=exclusions;selection.lock(exclusions.plan.folders);}
					throw error;
				}
			});
			review.close();dlg.close();
			const receipt=new Dialog(plugin.app,tr('知识库已创建','Knowledge base created'));
			receipt.facts([[tr('知识库路径','Library path'),result.location],[tr('分支','Branch'),result.branch],
				[tr('提交','Commit'),result.head],[tr('提交说明','Commit message'),result.message],
				[tr('作者与提交者','Author and committer'),result.author.name+' <'+result.author.email+'>'],['origin',result.origin||tr('未设置','Unset')]]);
			receipt.lines([tr('初始提交已验证，工作区干净，知识库已登记。','Verified the initial commit, clean working tree and library registration.')]);
			receipt.action(tr('关闭','Close'),()=>{receipt.close();return Promise.resolve();});
			receipt.open();await plugin.refresh();
		});
		review.open();
	});
	dlg.open();
}
function tokenField(dialog:Dialog,change:(value:string)=>void) {
	const label=tr('访问令牌（可选）','Access token (optional)');
	new Setting(dialog.contentEl).setName(label).addText(c=>{
		c.inputEl.setAttribute('aria-label',label);
		c.inputEl.type='password';c.inputEl.autocomplete='off';c.onChange(change);
	});
}
export function cloneForm(plugin:MobilePlugin) {
	const {ctx}=plugin,dlg=new Dialog(plugin.app,tr('克隆知识库','Clone knowledge base'));
	let name='',url='',user='',token='';
	const getParent=destinationParentField(dlg,plugin.app,ctx,ctx.registry);
	dlg.text(tr('目标目录名','Destination folder name'),'',v=>{name=v;},{example:'research-notes'});
	dlg.text(tr('远端 HTTPS 地址','Remote HTTPS URL'),'',v=>{url=v;});
	dlg.text(tr('认证用户名（可选）','Authentication username (optional)'),'',v=>{user=v;});
	tokenField(dlg,v=>{token=v;});
	dlg.action(tr('下载并预览','Download and preview'),async()=>{
		const parent=getParent(), dest=libraryDestination(parent,name), address=endpoint(url);
		const result=await plugin.exclusive(dest,()=>download(ctx,parent,name,address,mobileHttp(address),token?{username:user||'git',password:token}:undefined));
		dlg.close();
		let publishing=false,closed=false;
		class CloneReview extends Dialog {
			onClose(){super.onClose();closed=true;if(!publishing)void result.cleanup().catch(e=>plugin.report(e));}
		}
		const review=new CloneReview(plugin.app,tr('选择克隆清单','Choose the clone manifest'));
		review.lines([result.location,address,result.branch,result.head,...result.files]);
		if(result.tracked)review.lines([tr('远端跟踪 kb.toml。请另外检查 Git 索引和历史。','The remote tracks kb.toml. Review the Git index and history separately.')]);
		async function preview(choice:CloneChoice){
			const approved=await result.review(plugin.ctx,choice,plugin.templates.kepano),manifest=readManifest(approved.source);
			confirm(plugin,tr('确认克隆','Confirm clone'),[result.location,address,result.branch,result.head,
				manifest.identity!.displayName+' · '+manifest.identity!.id,...(manifest.identity!.entry?[manifest.identity!.entry]:[]),
				tr('路径不同时，请在克隆后核对普通链接和 Base 路径。','If the library path changed, check ordinary links and Base paths after cloning.'),
				...Object.entries(manifest.preferences).map(([key,value])=>'preferences.'+key+' = '+String(value)),
				...bindingLines(approved.bindings),...registryIgnoreLines(approved.registryIgnore)],async()=>{
				publishing=true;
				try{plugin.assertEnabled();await plugin.catalogWrite(()=>result.publish(plugin.ctx,approved,plugin.templates.kepano));review.close();}
				finally{publishing=false;if(closed)await result.cleanup();}
			});
		}
		if(result.hasManifest)review.action(tr('预览远端自带清单','Preview the remote manifest'),()=>preview({mode:'embedded'}));
		else{
			const picker=review.contentEl.createEl('input',{attr:{type:'file',accept:'.toml','aria-label':tr('原知识库的 kb.toml','Original library kb.toml')}});
			review.action(tr('预览原知识库清单','Preview the original manifest'),async()=>{
				const file=picker.files?.[0];
				if(!file || file.name!=='kb.toml')throw new Error(tr('请选择原知识库的 kb.toml','Select kb.toml from the original library'));
				await preview({mode:'original',raw:decode(new Uint8Array(await file.arrayBuffer()))});
			});
			review.action(tr('预览按新库接管','Preview adoption as a new library'),()=>preview({mode:'new'}));
		}
		review.open();
	});
	dlg.open();
}
export async function librarySettings(plugin:MobilePlugin,lib:Library,owner:Window=activeWindow) {
	plugin.assertEnabled();
	const store=plugin.store(lib),old=await mobileStatus(store),author=await localAuthor(store);
	const dlg=new Dialog(plugin.app,tr('本库 Git 设置','Library Git settings'),owner);
	const target=lib.location+'/.git/config',keys=['name','email'] as const;
	const draft={...author};
	const changedFields=()=>keys.filter(key=>draft[key]!==author[key]);
	dlg.facts([[tr('本库配置','Library config'),target]]);
	const fields=panelGroup(dlg.contentEl,tr('本库覆盖值','Local overrides'));
	const inherit=tr('可留空，继承本设备的 Vault 默认值','Optional · inherit the vault default on this device');
	const capture=()=>{
		const next={...draft},device=plugin.deviceAuthor(),changed=changedFields();
		if(keys.some(key=>/[<>]/u.test(next[key]) || Array.from(next[key]).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127)))
			throw new Error(tr('身份含无效字符','Invalid identity characters'));
		return {next,device,changed};
	};
	const apply=async({next,device,changed}:ReturnType<typeof capture>,preview?:Dialog)=>{
		const updates=Object.fromEntries(changed.map(key=>['user.'+key,next[key]||undefined]));
		await plugin.exclusive(lib.location,()=>configure(store,old,updates,()=>{
			const freshDevice=plugin.deviceAuthor();
			if(changed.some(key=>(!next[key].trim() || !author[key].trim()) && device[key].trim()!==freshDevice[key].trim()))
				throw new Error(tr('继承的提交身份已变化，请重新预览','Inherited commit identity changed. Preview again.'));
		}),lib);
		preview?.close();dlg.close();await plugin.refresh();
	};
	const source=(local:string,inherited:string)=>local.trim()
		?local.trim()+' · '+tr('本库','Local')
		:(inherited.trim()||tr('未设置','Unset'))+' · '+tr('本设备的 Vault 默认值','Vault default on this device');
	const review=(origin:HTMLButtonElement)=>{
		const plan=capture();
		const preview=new Dialog(plugin.app,tr('预览 Git 提交身份变更','Review Git identity changes'),owner).returnFocusTo(origin);
		preview.facts([[tr('写入位置','Save to'),target]]);
		changeComparison(preview.contentEl,plan.changed.map(key=>({
			label:'user.'+key,before:source(author[key],plan.device[key]),after:source(plan.next[key],plan.device[key]),
			...(!plan.next[key] && {afterLabel:tr('变更后 · 继承','After · Inherit')}),
		})));
		changeActions(preview.contentEl,[{label:tr('应用变更','Apply changes'),run:()=>apply(plan,preview),primary:true}]);
		preview.open();return Promise.resolve();
	};
	for(const key of keys)dialogContents(fields).text('user.'+key,author[key],value=>{
		draft[key]=value.trim();
		actions.setDisabled(!changedFields().length);
	},inherit);
	const actions=changeActions(fields,[
		{label:tr('预览变更','Preview changes'),run:review},
		{label:tr('直接应用','Apply directly'),run:()=>apply(capture()),primary:true},
	]);
	actions.setDisabled(true);
	dlg.open();
}
export async function remoteSettings(plugin:MobilePlugin,lib:Library,owner:Window=activeWindow) {
	plugin.assertEnabled();
	const store=plugin.store(lib),old=await mobileStatus(store),current=await upstream(store,old.branch);
	const dlg=new Dialog(plugin.app,tr('本库 HTTPS 远端','Library HTTPS remote'),owner);
	const remote=current?.remote??'origin',target=lib.location+'/.git/config';
	const urlLabel=tr('远端 HTTPS 地址','Remote HTTPS URL'),branchLabel=tr('上游分支','Upstream branch');
	let url=current?.url??'',branch=current?.branch??old.branch,user='',token='',clear=false;
	dlg.facts([[tr('本库配置','Library config'),target],[tr('远端','Remote'),remote]]);
	dlg.text(urlLabel,url,v=>{url=v;});
	dlg.text(branchLabel,branch,v=>{branch=v;});
	dlg.text(tr('认证用户名（可选）','Authentication username (optional)'),'',v=>{user=v;});
	tokenField(dlg,v=>{token=v;});
	new Setting(dlg.contentEl).setName(tr('清除这个地址的已保存令牌','Clear saved token for this address')).addToggle(c=>c.onChange(v=>{clear=v;}));
	changeActions(dlg.contentEl,[{label:tr('预览远端设置','Preview remote settings'),primary:true,run:async origin=>{
		const addr=endpoint(url),ref=branchName(branch),id=lib.identity!.id;
		const credential=token?JSON.stringify({username:user||'git',password:token}):undefined,remove=clear;
		if(remove && credential)throw new Error(tr('请选择更新或清除令牌','Choose either update or clear token'));
		const key=await secretKey(id,addr);
		const updates={['remote.'+remote+'.url']:addr,['remote.'+remote+'.fetch']:'+refs/heads/*:refs/remotes/'+remote+'/*',
			['branch.'+old.branch+'.remote']:remote,['branch.'+old.branch+'.merge']:'refs/heads/'+ref};
		const preview=new Dialog(plugin.app,tr('确认远端设置','Confirm remote settings'),owner).returnFocusTo(origin);
		preview.facts([[tr('写入位置','Save to'),target],[tr('远端','Remote'),remote]]);
		changeComparison(preview.contentEl,[
			{label:urlLabel,before:current?.url??'',after:addr},
			{label:branchLabel,before:current?.branch??'',after:ref},
		]);
		preview.facts([[tr('凭据','Credentials'),remove?tr('清除本设备令牌','Clear device token'):
			credential?tr('更新本设备令牌','Update device token'):tr('保留凭据','Keep credentials')]]);
		changeActions(preview.contentEl,[{label:tr('保存远端设置','Save remote settings'),primary:true,run:async()=>{
			await plugin.exclusive(lib.location,async()=>{
				await configure(store,old,updates);
				if(remove || credential)plugin.app.secretStorage.setSecret(key,credential??'');
			},lib);
			preview.close();dlg.close();await plugin.refresh();
		}}]);
		preview.open();
	}}]);
	dlg.open();
}
