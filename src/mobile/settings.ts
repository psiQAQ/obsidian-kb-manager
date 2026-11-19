import {PluginSettingTab,Setting} from 'obsidian';
import type {App} from 'obsidian';
import {tr} from '../i18n.ts';
import {Dialog} from '../ui/dialog.ts';
import {registryIgnoreForm} from './registration-forms.ts';
import type MobilePlugin from './plugin.ts';

export class MobileSettings extends PluginSettingTab {
	constructor(app:App,private plugin:MobilePlugin){super(app,plugin);}
	display(){
		const el=this.containerEl;el.empty();
		const p=this.plugin;
		new Setting(el).setName(tr('目录与语言','Directories and language')).addButton(c=>c.setButtonText(tr('打开','Open')).onClick(()=>this.directories()));
		new Setting(el).setName(tr('Vault Git 忽略规则','Vault Git ignore rule')).addButton(c=>c.setButtonText(tr('预览','Preview')).onClick(async()=>{
			try{await registryIgnoreForm(p);}catch(error){p.report(error);}
		}));
		new Setting(el).setName(tr('本设备的 Vault 提交身份','Vault commit identity on this device')).addButton(c=>c.setButtonText(tr('设置','Configure')).onClick(()=>this.identity()));
		new Setting(el).setName(tr('暂停本设备 Git','Pause Git on this device')).addToggle(c=>c.setValue(p.paused()).onChange(async v=>{
			p.app.saveLocalStorage(p.manifest.id+':gitDisabled',v);await p.refresh();
		}));
		el.createEl('p',{text:tr('移动版支持 HTTPS 与快进拉取。SSH 和变基需要桌面 Git。','Mobile supports HTTPS and fast-forward pulls. SSH and rebase require desktop Git.')});
		el.createEl('p',{text:tr('远端必须支持移动 WebView 的跨域请求（CORS）并提供无需重定向的地址。','The remote must allow CORS from the mobile WebView and offer a direct URL without redirects.')});
	}
	private directories(){
		const p=this.plugin,ctx=p.ctx;
		let parents=ctx.parents.join('\n'),templates=ctx.templates.join('\n'),language:string=p.saved.language;
		const dlg=new Dialog(p.app,tr('目录与语言','Directories and language'));
		for(const [label,value,placeholder,change] of [
			[tr('知识库父目录（每行一个）','Library parent directories (one per line)'),parents,'knowledge-base',(v:string)=>{parents=v;}],
			[tr('自定义模板目录（每行一个）','Custom template directories (one per line)'),templates,tr('可留空，例如 templates/wiki','Optional, e.g. templates/wiki'),(v:string)=>{templates=v;}]
		] as const)new Setting(dlg.contentEl).setName(label).addTextArea(c=>c.setValue(value).setPlaceholder(placeholder).onChange(change));
		new Setting(dlg.contentEl).setName(tr('语言','Language')).addDropdown(c=>c.addOptions({system:tr('系统默认','System default'),zh:'中文',en:'English'}).setValue(language).onChange(v=>{language=v;}));
		dlg.action(tr('保存','Save'),async()=>{
			const paths=(v:string)=>v.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean);
			await p.saveConfig(paths(parents),paths(templates),language);dlg.close();this.display();
		});
		dlg.open();
	}
	private identity(){
		const p=this.plugin;
		const draft=p.deviceAuthor(),dialog=new Dialog(p.app,tr('本设备的 Vault 提交身份','Vault commit identity on this device'));
		dialog.lines([tr('同一 Vault 中，知识库缺少的作者字段将从这里读取。身份保存在此设备的 SecretStorage。','Libraries in this vault inherit missing author fields from this device’s secret storage.')]);
		const optional=tr('可留空','Optional');
		dialog.text(tr('默认姓名','Default name'),draft.name,v=>{draft.name=v;},optional);
		dialog.text(tr('默认邮箱','Default email'),draft.email,v=>{draft.email=v;},optional);
		dialog.action(tr('保存到本设备','Save on this device'),()=>{p.setDeviceAuthor(draft.name,draft.email);dialog.close();return Promise.resolve();});
		dialog.open();
	}
}
