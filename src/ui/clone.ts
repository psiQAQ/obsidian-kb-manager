import { reviewRegistryProtection } from './registry-ignore.ts';
import { assertGitEnabled } from './device.ts';
import { Notice, Setting } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { cloneTarget, downloadLibrary } from '../kb/clone.ts';
import type { CloneManifestChoice } from '../kb/clone.ts';
import { parseIdentity } from '../kb/identity-core.ts';
import { V3Dialog, dialogContents } from './dialog.ts';
import { changeActions } from './change-preview.ts';
import { destinationParentField } from './registry-path-field.ts';

export function cloneWizard(plugin:KnowledgeBaseManager,owner:Window=activeWindow) {
	const t=plugin.t;
	try{assertGitEnabled(plugin);}catch(error){new Notice(error instanceof Error?error.message:String(error));return;}
	const input={name:'',url:''};
	let username='',password='';
	const form=new V3Dialog(plugin.app,t('克隆知识库','Clone library'),owner);
	const getParent=destinationParentField(form,plugin.app,plugin.config,plugin.disk.registry,{
		compact:true,title:t('选择克隆知识库的父目录','Choose the parent folder for the clone'),
	});
	form.text(t('新目录名','New folder name'),'',v=>{input.name=v;},{example:'research-notes'});
	form.text(t('远端仓库地址','Remote repository URL'),'',v=>{input.url=v.trim();},{placeholder:'HTTPS / SSH'});
	const authentication=form.contentEl.createEl('details',{cls:'kb-v3-detail'});
	authentication.createEl('summary',{text:t('备用 HTTPS 认证','Fallback HTTPS authentication')});
	dialogContents(authentication).text(t('用户名（可选）','Username (optional)'),'',v=>{username=v;});
	const token=t('HTTPS 令牌','HTTPS token');
	new Setting(authentication).setName(token).setDesc(t('仅用于本次下载。留空时使用系统认证。',
		'Used for this download only. Leave blank to use system authentication.')).addText(field=>{
		field.inputEl.type='password';
		field.inputEl.setAttribute('aria-label',token);
		field.onChange(value=>{password=value;});
	});
	form.action(t('预览下载','Preview download'),async origin=>{
		const request={...input,parent:getParent()};
		const auth=password?{username:username||'git',password}:undefined;
		const target=await cloneTarget(plugin.disk,plugin.config,request);
		const confirm=new V3Dialog(plugin.app,t('确认下载知识库','Confirm library download'),owner).returnFocusTo(origin);
		confirm.facts([[t('远端仓库','Remote repository'),target.display],[t('仓库内位置','Location in vault'),target.relative+'/']]);
		confirm.contentEl.createEl('p',{text:t('先下载到临时目录，再检查文件、选择身份并导入。',
			'Download to a temporary folder, then inspect files and select an identity before importing.')});
		if(target.warnings.length)confirm.lines(target.warnings);
		const protect=await reviewRegistryProtection(plugin,confirm);
		const download=async()=>{
			const clone=await plugin.exclusiveGit(target.relative,()=>downloadLibrary(plugin.disk,plugin.config,request,auth));
			confirm.close();form.close();
			let publishing=false;
			class ImportPreview extends V3Dialog{
				onClose(){
					super.onClose();
					if(!publishing)void clone.cleanup().catch(error=>new Notice(String(error)));
				}
			}
			const preview=new ImportPreview(plugin.app,t('导入知识库','Import library'),owner);
			preview.facts([[t('仓库内位置','Location in vault'),target.relative+'/'],
				[t('分支与提交','Branch and commit'),clone.branch+' · '+clone.head]]);
			const files=preview.contentEl.createEl('details',{cls:'kb-v3-detail'});
			files.createEl('summary',{text:t('下载的文件','Downloaded files')+' ('+clone.files.length+')'});
			dialogContents(files).lines(clone.files);
			if(clone.tracked)preview.lines([t('远端跟踪 kb.toml。Git 历史和暂存区将保留；导入后若要同步，请先在 Git 中将清单取消跟踪。','The remote tracks kb.toml. Git history and the index are retained. Untrack the manifest in Git before syncing.')]);
			preview.lines([t('导入后可从“检验”检查链接与可移植性。恢复原清单时可按原记录复核受管路径；按新库接管时请核对旧链接。','After import, use Check library to check links and portability. The original manifest supplies binding records. Review existing links when adopting a new identity.')]);
			const publish=async(choice?:CloneManifestChoice)=>{
				publishing=true;
				try{
					await plugin.exclusiveGit(target.relative,()=>clone.publish(plugin.config,choice,protect));
					preview.close();await plugin.refresh();
				}finally{
					publishing=false;
					if(!preview.containerEl.isConnected)await clone.cleanup();
				}
			};
			if(clone.identity){
				preview.facts([[t('远端知识库身份','Remote library identity'),clone.identity.displayName+' · '+clone.identity.id]]);
				changeActions(preview.contentEl,[{label:t('保留身份并导入','Import with existing identity'),primary:true,run:()=>publish()}]);
			}else{
				preview.contentEl.createEl('h3',{text:t('使用原库身份','Use the original library identity')});
				preview.contentEl.createEl('p',{text:t('选择原库的 kb.toml，复核后保留它的知识库 ID。',
					'Select kb.toml from the original library and review its library ID before importing.')});
				const picker=preview.contentEl.createEl('input',{attr:{type:'file',accept:'.toml','aria-label':t('原库的 kb.toml','Original library kb.toml')}});
				preview.action(t('预览原库清单','Preview original manifest'),async origin=>{
					const file=picker.files?.[0];
					if(!file)throw new Error(t('请选择原库的 kb.toml','Choose kb.toml from the original library'));
					const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());
					const identity=parseIdentity(raw);
					const original=new V3Dialog(plugin.app,t('使用原库清单','Use original manifest'),owner).returnFocusTo(origin);
					original.facts([[t('知识库身份','Library identity'),identity.displayName+' · '+identity.id],
						[t('清单目标','Manifest destination'),target.relative+'/kb.toml']]);
					if(clone.tracked)original.lines([t('原库清单将替换工作区中的远端清单。','The original manifest will replace the remote manifest in the working tree.')]);
					changeActions(original.contentEl,[
						{label:t('返回导入预览','Back to import preview'),run:()=>{original.close();return Promise.resolve();}},
						{label:t('保留此身份并导入','Import with this identity'),primary:true,run:async()=>{
							await publish({kind:'original',raw});original.close();
						}},
					]);
					original.open();
				});
				preview.contentEl.createEl('h3',{text:t('登记为新知识库','Register as a new library')});
				preview.contentEl.createEl('p',{text:t('为下载的库生成新 ID，沿用仓库的 Git 历史。',
					'Generate a new library ID and keep the repository’s Git history.')});
				changeActions(preview.contentEl,[{label:t('接管为新库并生成新 ID','Adopt as a new library with a new ID'),
					run:()=>publish({kind:'new'})}]);
			}
			preview.open();
		};
		changeActions(confirm.contentEl,[
			{label:t('返回下载设置','Back to download settings'),run:()=>{confirm.close();return Promise.resolve();}},
			{label:t('下载并检查文件','Download and inspect files'),primary:true,run:download},
		]);
		confirm.open();
	}).setCta();form.open();
}
