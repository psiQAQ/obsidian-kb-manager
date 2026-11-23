import {Setting} from 'obsidian';
import type {App,ToggleComponent,Vault} from 'obsidian';
import {tr} from '../i18n.ts';
import type {Dialog} from './dialog.ts';
import type {PluginDataRegistry} from '../registry/plugin-data.ts';
import {applyExclusionPlan,assertExclusionPlan,planNewExclusions,templateFolderRule} from '../kb/template-exclusions.ts';
import type {ExclusionPlan,ExclusionStore} from '../kb/template-exclusions.ts';

function filters(data:unknown):string[]{
	const list=data??[];
	if(!Array.isArray(list) || !list.every((v:unknown)=>typeof v==='string'))throw new Error(tr('Vault 排除规则格式无效','Invalid vault exclusions'));
	return list;
}

export function vaultExclusions(app:App,registry:PluginDataRegistry):ExclusionStore {
	const {vault}=app;
	const config=vault as Vault & {getConfig(key:string):unknown;setConfig(key:string,value:string[]):void};
	const path=vault.configDir+'/app.json';
	const readRules=async()=>{
		if(!await vault.adapter.exists(path))return [];
		const data=JSON.parse(await vault.adapter.read(path)) as {userIgnoreFilters?:unknown};
		return filters(data.userIgnoreFilters);
	};
	const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
	return {
		readRules,
		writeRules:async(before,after)=>{
			if(!same(await readRules(),before) || !same(filters(config.getConfig('userIgnoreFilters')),before))
				throw new Error(tr('Vault 设置正在更新，请稍后重试。','Vault settings are changing. Try again shortly.'));
			config.setConfig('userIgnoreFilters',after);
			for(let attempt=0;attempt<30;attempt++){
				if(same(await readRules(),after))return;
				await new Promise(resolve=>window.setTimeout(resolve,100));
			}
			throw new Error(tr('未能核验 Vault 排除规则写入，请检查 Obsidian 设置后重试。','Could not verify the vault exclusions. Check Obsidian Settings and retry.'));
		},
		readOwnership:id=>registry.readExclusionOwnership(id),
		writeOwnership:(id,before,after)=>registry.writeExclusionOwnership(id,before,after),
	};
}

export function showExclusionPlan(dialog:Pick<Dialog,'lines'>,plan:ExclusionPlan){
	const lines=[
		...plan.remove.map(rule=>tr('移除插件添加的规则 ','Remove a rule added by this plugin ')+rule),
		...plan.add.map(rule=>tr('添加排除规则 ','Add exclusion ')+rule),
		...plan.warnings,
	];
	if(lines.length)dialog.lines(lines);
}

export interface ApprovedExclusions {
	plan:ExclusionPlan;
	check(id?:string):Promise<void>;
	apply(id:string):Promise<void>;
}

export async function reviewCreationExclusions(app:App,registry:PluginDataRegistry,dialog:Pick<Dialog,'contentEl'|'lines'>,
	location:string,suggestions:readonly string[],initialSelection:readonly string[]=suggestions){
	const store=vaultExclusions(app,registry),rules=await store.readRules();
	const selected=new Set(initialSelection);
	const controls=new Map<string,ToggleComponent>();
	if(suggestions.length){
		dialog.contentEl.createEl('h3',{text:tr('从 Obsidian 搜索和关系图谱中排除','Exclude from Obsidian search and graph')});
		dialog.contentEl.createEl('p',{cls:'kb-v3-muted',text:tr(
			'排除目录后，依赖该目录的 Bases 视图可能看不到页面模板。希望在这些视图里浏览模板时，请取消勾选对应目录。',
			'Excluding a folder may hide its page templates from Bases views. Clear the corresponding option to browse the templates in those views.')});
		for(const folder of suggestions){
			const rule=templateFolderRule(location,folder);
			const folderPath=location+'/'+folder;
			new Setting(dialog.contentEl).setName(folderPath)
				.setDesc(rules.includes(rule)?tr('保留现有规则','Keep the existing rule'):rule)
				.addToggle(toggle=>{
					controls.set(folder,toggle);
					toggle.toggleEl.setAttribute('aria-label',tr('排除目录','Exclude folder')+' · '+folderPath);
					toggle.setValue(selected.has(folder)).onChange(enabled=>{
						if(enabled)selected.add(folder);
						else selected.delete(folder);
					});
				});
		}
	}
	const current=()=>planNewExclusions(rules,location,suggestions.filter(folder=>selected.has(folder)));
	const {warnings}=current();
	if(warnings.length)dialog.lines(warnings);
	return {
		read():ApprovedExclusions{
			const plan=current();
			return {plan,check:(id='')=>assertExclusionPlan(store,{...plan,id},!!id),apply:id=>applyExclusionPlan(store,{...plan,id})};
		},
		lock:(folders:readonly string[])=>{
			for(const [folder,toggle] of controls)toggle.setValue(folders.includes(folder)).setDisabled(true);
		},
	};
}
