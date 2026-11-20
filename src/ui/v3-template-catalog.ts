import { Setting } from 'obsidian';
import type { ButtonComponent } from 'obsidian';
import { readFile } from 'node:fs/promises';
import { statIfPresent } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { declaration } from '../kb/template.ts';
import { builtinPacks, builtinSource } from '../kb/template-pack.ts';
import type { PackDescriptor } from '../kb/template-pack.ts';
import type KnowledgeBaseManager from '../main.ts';
import { Dialog } from './dialog.ts';

export function purposeLabels() {
	return {
		starter:tr('入门与日常','Starter and daily notes'),
		collections:tr('资料与收藏','Collections'),
		research:tr('课题研究','Research'),
		reading:tr('专题阅读','Reading'),
		learning:tr('课程与学习','Learning'),
		engineering:tr('工程与经验分享','Engineering and knowledge sharing'),
		projects:tr('项目与行动','Projects and actions'),
		writing:tr('写作与世界观','Writing and worldbuilding'),
		'ai-workflows':tr('AI 协作','AI workflows'),
	};
}

export function dependencyLabel(id:string) {
	const names:Record<string,string>={dataview:'Dataview','obsidian-meta-bind-plugin':'Meta Bind','obsidian-spaced-repetition':'Spaced Repetition','obsidian-tasks-plugin':'Tasks','templater-obsidian':'Templater',quickadd:'QuickAdd'};
	return names[id] ?? id;
}

export type TemplateChoice = Pick<PackDescriptor,'name'|'description'|'purpose'|'purposes'|'dependencies'|'sources'> & {
	source:string;
	entry?:string;
	personal?:boolean;
	invalid?:string;
};

async function personalTemplate(plugin:KnowledgeBaseManager,source:string):Promise<TemplateChoice> {
	const fallback={source,name:source.split('/').at(-1) ?? source,description:'',purpose:'',personal:true};
	try {
		const file=await plugin.disk.path(source+'/kb-template.json');
		const found=await statIfPresent(file);
		if(!found)return fallback;
		if(!found.isFile())throw new Error(tr('模板声明必须为普通文件','Expected a regular template declaration file'));
		const spec=declaration(await readFile(file,'utf8'));
		return {...fallback,...spec,name:spec.name ?? fallback.name,description:spec.description ?? '',purpose:spec.purpose ?? ''};
	} catch(error) { return {...fallback,invalid:String(error)}; }
}

function builtinTemplates():TemplateChoice[] {
	return builtinPacks().map(pack=>({...pack,source:builtinSource(pack.id)}));
}

export async function choiceForSource(plugin:KnowledgeBaseManager,source:string):Promise<TemplateChoice> {
	return builtinTemplates().find(template=>template.source===source) ?? await personalTemplate(plugin,source);
}

export function showTemplateDetails(parent:HTMLElement,template:TemplateChoice) {
	const labels:Record<string,string>=purposeLabels();
	const details=parent.createEl('dl',{cls:'kb-v3-template-details'});
	const line=(label:string,value:string)=>{
		details.createEl('dt',{text:label});
		details.createEl('dd',{text:value});
	};
	const purposes=[...new Set([template.purpose,...(template.purposes ?? [])])].filter(Boolean);
	if(purposes.length)line(tr('用途','Use cases'),purposes.map(id=>Object.prototype.hasOwnProperty.call(labels,id)?labels[id]:id).join(' · '));
	if(template.personal)line(tr('模板目录','Template folder'),template.source);
	if(template.entry)line(tr('首页','Home note'),template.entry);
	line(tr('社区插件','Community plugins'),template.dependencies?.length?template.dependencies.map(dependencyLabel).join(' · '):tr('无','None'));
	if(template.sources?.length){
		details.createEl('dt',{text:tr('来源','Sources')});
		const links=details.createEl('dd');
		for(const source of template.sources){
			const label=[source.author,source.license].filter(Boolean).join(' · ');
			let href:URL|undefined;
			try { href=new URL(source.url); } catch { /* Keep invalid URLs as plain text. */ }
			const item=links.createDiv();
			if(href && ['https:','http:'].includes(href.protocol))item.createEl('a',{text:label||href.hostname,href:href.href,attr:{target:'_blank',rel:'noopener noreferrer'}});
			else item.setText(label||source.url);
		}
	}
	if(template.invalid)parent.createEl('p',{cls:'kb-git-error',text:template.invalid});
}

export async function pickTemplate(plugin:KnowledgeBaseManager,onPick:(template:TemplateChoice)=>Promise<void>,initial?:TemplateChoice) {
	const templates=[...builtinTemplates(),...await Promise.all(plugin.config.templates.map(source=>personalTemplate(plugin,source)))];
	const dialog=new Dialog(plugin.app,tr('新建知识库','Create knowledge base'));
	dialog.modalEl.addClass('kb-v3-dialog');
	const labels:Record<string,string>=purposeLabels();
	const purposes=new Set(templates.flatMap(template=>[template.purpose,...(template.purposes ?? [])]).filter(Boolean));
	const order=[...new Set([...Object.keys(labels).filter(id=>purposes.has(id)),...purposes])];
	const options=Object.fromEntries(order.map(id=>[id,Object.prototype.hasOwnProperty.call(labels,id)?labels[id]:id]));
	const personal='@personal';
	let purpose=initial?(initial.personal?personal:initial.purpose):'';
	let selected=initial;
	const prompt=tr('选择用途','Select a use case');
	new Setting(dialog.contentEl).setName(tr('用途','Use case')).addDropdown(input=>{
		input.selectEl.setAttribute('aria-label',tr('用途','Use case'));
		input.addOptions({'':prompt,...options,[personal]:tr('我的模板','My templates')}).setValue(purpose).onChange(value=>{
			purpose=value;
			selected=undefined;
			render();
		});
	});
	const cards=dialog.contentEl.createDiv({cls:'kb-v3-template-list'});
	const details=dialog.contentEl.createDiv({cls:'kb-v3-template-selection',attr:{'aria-live':'polite'}});
	const next:ButtonComponent=dialog.action(tr('填写知识库信息','Enter library details'),async()=>{
		if(!selected || selected.invalid)return;
		await onPick(selected);
		dialog.close();
	}).setCta();
	function renderDetails(){
		details.empty();
		if(selected)showTemplateDetails(details,selected);
		next.setDisabled(!selected || !!selected.invalid);
	}
	function render(){
		cards.empty();
		if(purpose){
			const matched=templates.filter(p=>purpose===personal?p.personal:p.purpose===purpose||p.purposes?.includes(purpose));
			if(!matched.length)cards.createEl('p',{cls:'kb-v3-muted',text:tr('尚无目录模板。可在知识库目录与模板设置中制作或登记。','Create or register a folder template in the library folders and templates settings.')});
			for(const template of matched){
				const card=cards.createEl('button',{cls:'kb-v3-template-card',attr:{type:'button','data-template-source':template.source,'aria-pressed':String(template.source===selected?.source)}});
				card.createSpan({cls:'kb-v3-template-name',text:template.name});
				if(template.description)card.createSpan({cls:'kb-v3-muted',text:template.description});
				card.addEventListener('click',()=>{
					selected=template;
				cards.querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button===card)));
					renderDetails();
				});
			}
		}
		renderDetails();
	}
	render();
	dialog.open();
}
