import { reviewRegistryProtection } from './registry-ignore.ts';
import { gitDisabled } from './device.ts';
import { Notice, Setting } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { cloneTarget, downloadLibrary } from '../kb/clone.ts';
import type { CloneManifestChoice } from '../kb/clone.ts';
import { parseIdentity } from '../kb/identity-core.ts';
import { Dialog } from './dialog.ts';

export function cloneWizard(plugin:KnowledgeBaseManager) {
	const t=plugin.t;
	if(gitDisabled(plugin)){new Notice(t('本设备已停用 Git','Git is disabled on this device'));return;}
	const input={parent:plugin.config.parents[0]??'',name:'',url:''};
	let username='',password='';
	const form=new Dialog(plugin.app,t('克隆知识库','Clone library'));
	form.choice(t('父目录','Parent folder'),Object.fromEntries(plugin.config.parents.map(p=>[p,p])),v=>{input.parent=v;});
	form.text(t('新目录名','New folder name'),'',v=>{input.name=v;},{example:'research-notes'});
	form.text('HTTPS / SSH','',v=>{input.url=v.trim();});
	form.text(t('用户名（可选）','Username (optional)'),'',v=>{username=v;});
	new Setting(form.contentEl).setName(t('显式备用 HTTPS 令牌，仅本次使用；留空使用系统认证','Optional fallback HTTPS token for this download; leave empty for system authentication')).addText(field=>{
		field.inputEl.type='password';field.onChange(value=>{password=value;});
	});
	form.action(t('预览','Preview'),async()=>{
		const request={...input};
		const auth=password?{username:username||'git',password}:undefined;
		const target=await cloneTarget(plugin.disk,plugin.config,request);
		const confirm=new Dialog(plugin.app,t('确认下载知识库','Confirm library download'));
		const protect=await reviewRegistryProtection(plugin,confirm);
		confirm.lines([target.display+' → '+target.relative,...target.warnings]);
		confirm.action(t('下载并检查文件','Download and inspect files'),async()=>{
			const clone=await plugin.exclusiveGit(target.relative,()=>downloadLibrary(plugin.disk,plugin.config,request,auth));
			confirm.close();form.close();
			let publishing=false;
			class ImportPreview extends Dialog{
				onClose(){
					super.onClose();
					if(!publishing)void clone.cleanup().catch(error=>new Notice(String(error)));
				}
			}
			const preview=new ImportPreview(plugin.app,t('导入知识库','Import library'));
			preview.lines([target.relative,clone.branch+' · '+clone.head,...clone.files]);
			if(clone.tracked)preview.lines([t('远端跟踪 kb.toml。Git 历史和暂存区将保留；导入后若要同步，请先在 Git 中将清单取消跟踪。','The remote tracks kb.toml. Git history and the index are retained. Untrack the manifest in Git before syncing.')]);
			preview.lines([t('导入后可从库菜单的“体检”检查路径绑定。','After importing, select Check library from the library menu to review path bindings.')]);
			const publish=async(choice?:CloneManifestChoice)=>{
				publishing=true;
				try{
					await plugin.exclusiveGit(target.relative,async()=>{await protect();await clone.publish(plugin.config,choice);});
					preview.close();await plugin.refresh();
				}finally{
					publishing=false;
					if(!preview.containerEl.isConnected)await clone.cleanup();
				}
			};
			if(clone.identity){
				preview.lines([clone.identity.displayName+' · '+clone.identity.id]);
				preview.action(t('保留身份并导入','Import with existing identity'),()=>publish());
			}else{
				const picker=preview.contentEl.createEl('input',{attr:{type:'file',accept:'.toml','aria-label':t('原库的 kb.toml','Original library kb.toml')}});
				preview.action(t('预览原库清单','Preview original manifest'),async()=>{
					const file=picker.files?.[0];
					if(!file)throw new Error(t('请选择原库的 kb.toml','Choose kb.toml from the original library'));
					const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await file.arrayBuffer());
					const identity=parseIdentity(raw);
					const original=new Dialog(plugin.app,t('使用原库清单','Use original manifest'));
					original.lines([identity.displayName+' · '+identity.id, target.relative+'/'+ 'kb.toml',
						...(clone.tracked?[t('原库清单将替换工作区中的远端清单。','The original manifest will replace the remote manifest in the working tree.')]:[])]);
					original.action(t('保留此身份并导入','Import with this identity'),async()=>{await publish({kind:'original',raw});original.close();});
					original.open();
				});
				preview.action(t('接管为新库并生成新 ID','Adopt as a new library with a new ID'),()=>publish({kind:'new'}));
			}
			preview.open();
		});confirm.open();
	});form.open();
}
