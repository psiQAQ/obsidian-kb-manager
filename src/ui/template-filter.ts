import type {Vault} from 'obsidian';
import {tr} from '../i18n.ts';
import type {Dialog} from './dialog.ts';
import {kepanoSource} from '../kb/template-core.ts';

export const templateIgnoreRule='/(^|[/])Templates[/]/';

interface FilterStore {
	read(): Promise<string[]>;
	append(): Promise<void>;
}

export async function planTemplateFilter(source:string|undefined, store:FilterStore){
	if(source && source!==kepanoSource)return;
	const missing=!(await store.read()).includes(templateIgnoreRule);
	return {missing,async apply(){
		if((await store.read()).includes(templateIgnoreRule))return;
		if(!missing)throw new Error(tr('模板排除规则已移除，请重新预览。','The template exclusion was removed. Review creation again.'));
		await store.append();
		if(!(await store.read()).includes(templateIgnoreRule))throw new Error(tr('未能验证 Vault 模板排除规则。','Could not verify the vault template exclusion.'));
	}};
}

export async function reviewTemplateFilter(vault:Vault,dialog:Dialog,source:string|undefined){
	const config=vault as Vault & {getConfig(key:string):unknown;setConfig(key:string,value:string[]):void};
	const read=()=>{
		const list:unknown=config.getConfig('userIgnoreFilters')??[];
		if(!Array.isArray(list)|| !list.every((v:unknown)=>typeof v==='string'))throw new Error(tr('Vault 排除规则格式无效','Invalid vault exclusions'));
		return list;
	};
	const path=vault.configDir+'/app.json';
	const persisted=async()=>{
		if(!await vault.adapter.exists(path))return [];
		const data=JSON.parse(await vault.adapter.read(path)) as {userIgnoreFilters?:unknown};
		const filters=data.userIgnoreFilters??[];
		if(!Array.isArray(filters)|| !filters.every((v:unknown)=>typeof v==='string'))throw new Error(tr('Vault 排除规则格式无效','Invalid vault exclusions'));
		return filters;
	};
	const plan=await planTemplateFilter(source,{read:persisted,async append(){
		const previous=await persisted();
		const current=read();
		if(previous.includes(templateIgnoreRule))return;
		if(JSON.stringify(previous)!==JSON.stringify(current.filter(rule=>rule!==templateIgnoreRule)))
			throw new Error(tr('Vault 设置正在更新，请稍后重新预览。','Vault settings are changing. Review again.'));
		config.setConfig('userIgnoreFilters',[...previous,templateIgnoreRule]);
		for(let i=0;i<30;i++){
			if(await vault.adapter.exists(path)){
				const data=JSON.parse(await vault.adapter.read(path)) as {userIgnoreFilters?:string[]};
				if(data.userIgnoreFilters?.includes(templateIgnoreRule))return;
			}
			await new Promise(resolve=>window.setTimeout(resolve,100));
		}
		throw new Error(tr('保存 Vault 模板排除规则失败，请检查 app.json 后重试。','Saving the vault template exclusion failed. Check app.json and retry.'));
	}});
	if(plan?.missing){
		dialog.contentEl.createEl('h3',{text:tr('将修改 Vault 设置','Vault settings change')});
		dialog.contentEl.createEl('code',{text:templateIgnoreRule});
		dialog.contentEl.createEl('p',{text:tr('整个 Vault 的关系图谱和搜索将排除各层 Templates/ 目录中的文件。','Graph and search will exclude files inside Templates/ folders throughout this vault.')});
	}
	return async()=>{await plan?.apply();};
}
