import {PluginSettingTab,Setting} from 'obsidian';
import type {App,SettingDefinitionItem} from 'obsidian';
import {tr} from '../i18n.ts';
import {Dialog} from '../ui/dialog.ts';
import {registryIgnoreForm} from './registration-forms.ts';
import type MobilePlugin from './plugin.ts';

export class MobileSettings extends PluginSettingTab {
	constructor(app:App,private plugin:MobilePlugin){super(app,plugin);}
	getSettingDefinitions(): SettingDefinitionItem[] {
		const p=this.plugin;
		const support = tr('移动版支持 HTTPS 与快进拉取。SSH 和变基需要桌面 Git。','Mobile supports HTTPS and fast-forward pulls. SSH and rebase require desktop Git.');
		const cors = tr('远端必须支持移动 WebView 的跨域请求（CORS）并提供无需重定向的地址。','The remote must allow CORS from the mobile WebView and offer a direct URL without redirects.');
		return [{type:'group',cls:'kb-settings',items:[{
			name:tr('目录与语言','Directories and language'),
			aliases:[tr('收藏的父目录','Favorite parent folders'),tr('自定义模板目录','Custom template directories'),tr('语言','Language')],
			render:setting=>{setting.addButton(c=>c.setButtonText(tr('打开','Open')).onClick(()=>this.directories()));},
		},{
			name:tr('仓库的 Git 忽略规则','Vault Git ignore rule'),
			render:setting=>{setting.addButton(c=>c.setButtonText(tr('预览','Preview')).onClick(async()=>{
				try { await registryIgnoreForm(p); } catch (error) { p.report(error); }
			}));},
		},{
			name:tr('此仓库在本设备上的提交身份','Vault commit identity on this device'),
			aliases:[tr('默认姓名','Default name'),tr('默认邮箱','Default email')],
			render:setting=>{setting.addButton(c=>c.setButtonText(tr('设置','Configure')).onClick(()=>this.identity()));},
		},{
			name:tr('在本设备暂停知识库 Git','Pause library Git on this device'),
			render:setting=>{setting.addToggle(c=>c.setValue(p.paused()).onChange(async v=>{
				p.app.saveLocalStorage(p.manifest.id+':gitDisabled',v);await p.refresh();
			}));},
		},{
			name:'',searchable:false,
			render:setting=>{for(const text of [support,cors])setting.descEl.createEl('p',{text});},
		}]}];
	}
	private directories(){
		const p=this.plugin,ctx=p.ctx;
		let parents=ctx.parents.join('\n'),templates=ctx.templates.join('\n'),language:string=p.saved.language;
		const dlg=new Dialog(p.app,tr('目录与语言','Directories and language'));
		for(const [label,value,example,change] of [
			[tr('收藏的父目录（每行一个，可留空）','Favorite parent folders (optional, one per line)'),parents,'knowledge-base',(v:string)=>{parents=v;}],
			[tr('自定义模板目录（每行一个）','Custom template directories (one per line)'),templates,'templates/wiki',(v:string)=>{templates=v;}]
		] as const)dlg.multiline(label,value,change,{placeholder:example});
		const languageLabel=tr('界面语言','Language');
		new Setting(dlg.contentEl).setName(languageLabel).addDropdown(input=>{
			input.selectEl.setAttribute('aria-label',languageLabel);
			input.addOptions({system:tr('跟随 Obsidian','Follow Obsidian'),zh:'简体中文',en:'English'}).setValue(language).onChange(v=>{language=v;});
		});
		dlg.action(tr('保存','Save'),async()=>{
			const paths=(v:string)=>v.split(/\r?\n/u).map(s=>s.trim()).filter(Boolean);
			await p.saveConfig(paths(parents),paths(templates),language);dlg.close();this.update();
		});
		dlg.open();
	}
	private identity(){
		const p=this.plugin;
		const draft=p.deviceAuthor(),dialog=new Dialog(p.app,tr('此仓库在本设备上的提交身份','Vault commit identity on this device'));
		dialog.lines([tr('同一仓库中，知识库缺少的作者字段将从这里读取。身份保存在此设备的 SecretStorage。','Libraries in this vault inherit missing author fields from this device’s secret storage.')]);
		const optional=tr('可留空','Optional');
		dialog.text(tr('默认姓名','Default name'),draft.name,v=>{draft.name=v;},optional);
		dialog.text(tr('默认邮箱','Default email'),draft.email,v=>{draft.email=v;},optional);
		dialog.action(tr('保存到本设备','Save on this device'),()=>{p.setDeviceAuthor(draft.name,draft.email);dialog.close();return Promise.resolve();});
		dialog.open();
	}
}
