import { gitDisabled } from './device.ts';
import { Notice, Setting } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { cloneTarget, downloadLibrary } from '../kb/clone.ts';
import { Dialog } from './dialog.ts';

export function cloneWizard(plugin:KnowledgeBaseManager) {
	const t=plugin.t;
	if(gitDisabled(plugin)){new Notice(t('本设备已停用 Git','Git is disabled on this device'));return;}
	const input={parent:plugin.config.parents[0]??'',name:'',url:''};
	let username='',password='';
	const form=new Dialog(plugin.app,t('克隆知识库','Clone library'));
	form.choice(t('父目录','Parent folder'),Object.fromEntries(plugin.config.parents.map(p=>[p,p])),v=>{input.parent=v;});
	form.text(t('新目录名','New folder name'),'',v=>{input.name=v;});
	form.text('HTTPS URL','',v=>{input.url=v.trim();});
	form.text(t('用户名（可选）','Username (optional)'),'',v=>{username=v;});
	new Setting(form.contentEl).setName(t('本次下载使用的令牌','Token for this download')).addText(field=>{
		field.inputEl.type='password';field.onChange(value=>{password=value;});
	});
	form.action(t('预览','Preview'),async()=>{
		const request={...input};
		const auth=password?{username:username||'git',password}:undefined;
		const target=await cloneTarget(plugin.disk,plugin.config,request);
		const confirm=new Dialog(plugin.app,t('确认下载知识库','Confirm library download'));
		confirm.lines([target.url+' → '+target.relative,...target.warnings]);
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
			preview.action(t('导入到新目录','Import into new folder'),async()=>{
				publishing=true;
				try{
					await plugin.exclusiveGit(target.relative,()=>clone.publish(plugin.config));
					preview.close();await plugin.refresh();
				}finally{
					publishing=false;
					if(!preview.containerEl.isConnected)await clone.cleanup();
				}
			});preview.open();
		});confirm.open();
	});form.open();
}
