import { ButtonComponent, Notice, Setting, TFile, TFolder, resolveSubpath, setIcon } from 'obsidian';
import { offlineRunner } from '../kb/check-kit.ts';
import { writeFile } from 'node:fs/promises';
import { statIfPresent } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { commonCheckTrusted, listCommonChecks } from '../diagnostics/common.ts';
import { diagnosticFreshness, generalChecks, listDiagnosticHistory, listSpecialChecks, portabilityCheck, runDiagnostics } from '../diagnostics/index.ts';
import { linkCandidateIndex } from '../diagnostics/links.ts';
import { commonRuleSources } from '../kb/common-rules.ts';
import { officialCheckDigests, packText } from '../kb/template-pack.ts';
import type { Library } from '../kb/catalog.ts';
import { readVaultRegistry } from '../registry/desktop.ts';
import type KnowledgeBaseManager from '../main.ts';
import { createPanelTabs } from './panel-tabs.ts';
import { Dialog, V3Dialog, dialogContents } from './dialog.ts';
import { reviewDiagnosticScript, showCheckKitUpdate, trustedDigests } from './v3-check-scripts.ts';
import { diagnosticReportDetails, reportDate } from './v3-diagnostic-report.ts';
import {showCheckedItems} from './diagnostic-checked-items.ts';
import { templateIdentityLabel } from './template-labels.ts';
import type { ReportHistory } from './v3-diagnostic-report.ts';

type Options = Parameters<typeof runDiagnostics>[0];
type Report = Awaited<ReturnType<typeof runDiagnostics>>;
type Diagnostic = Report['checks'][number]['diagnostics'][number];
type Severity = Diagnostic['severity'];

const checkRules = new Map<string,{name:string}>([...generalChecks,portabilityCheck].map(rule=>[rule.id,rule]));
const checkName=(id:string,fallback:string)=>checkRules.get(id)?.name ?? fallback;

function linkOptions(plugin:KnowledgeBaseManager, location:string, registeredPaths:readonly string[], allVault:boolean, signal:AbortSignal):
	Pick<Options,'collectLinks'|'resolveLink'|'linkCandidates'|'linkCandidateScope'|'linkTargetVisibility'> {
	const {vault,metadataCache}=plugin.app;
	const vaultCandidates=linkCandidateIndex(function* () {for(const file of vault.getFiles())yield file.path;});
	function* candidatePaths(folders:TFolder[]) {
		const seen=new Set<string>();
		while(folders.length){
			signal.throwIfAborted();
			const folder=folders.pop()!;
			if(folder.path===location || seen.has(folder.path))continue;
			seen.add(folder.path);
			for(const child of folder.children){
				if(child instanceof TFolder)folders.push(child);
				else if(child instanceof TFile)yield child.path;
			}
		}
	}
	async function loadRegisteredCandidates() {
		const folders:TFolder[]=[];
		const missingLibraries:string[]=[],unavailableLibraries:string[]=[];
		for(const path of registeredPaths){
			signal.throwIfAborted();
			if(path===location)continue;
			const folder=vault.getFolderByPath(path);
			if(folder){folders.push(folder);continue;}
			try {
				const status=await statIfPresent(await plugin.disk.path(path));
				(status?.isDirectory() ? unavailableLibraries : missingLibraries).push(path);
			} catch {signal.throwIfAborted();unavailableLibraries.push(path);}
		}
		return {lookup:linkCandidateIndex(()=>candidatePaths(folders)),missingLibraries,unavailableLibraries};
	}
	let registeredCandidates:ReturnType<typeof loadRegisteredCandidates>|undefined;
	return {
		collectLinks:source=>{
			const cache=metadataCache.getCache(source);
			if(!cache)return undefined;
			const collect=(refs: typeof cache.links,kind:'link'|'embed')=>(refs ?? []).map(ref=>({
				target:ref.link,kind,decoded:true,line:ref.position.start.line+1,syntax:/^!?\[\[/u.test(ref.original)?'wiki' as const:'markdown' as const,
			}));
			return [...collect(cache.links,'link'),...collect(cache.embeds,'embed'),...(cache.frontmatterLinks ?? []).map(ref=>({target:ref.link,kind:'link' as const}))];
		},
		linkTargetVisibility:target=>{
			const visibility:unknown=metadataCache.getCache(target)?.frontmatter?.visibility;
			return visibility==='public' || visibility==='private' ? visibility : undefined;
		},
		resolveLink:request=>{
			const source=vault.getAbstractFileByPath(request.source);
			if(!(source instanceof TFile) || (source.extension==='md' && !metadataCache.getFileCache(source)))return {status:'unknown',reason:tr('Obsidian 元数据缓存尚未就绪。','Obsidian metadata cache is not ready.')};
			const target=!request.target?source:request.canvasPath?vault.getAbstractFileByPath(request.target):metadataCache.getFirstLinkpathDest(request.target,request.source);
			if(!(target instanceof TFile))return {status:'missing'};
			if(!request.fragment)return {status:'resolved',path:target.path};
			const cache=metadataCache.getFileCache(target);
			if(target.extension!=='md' || !cache)return {status:'resolved',path:target.path,anchor:'unknown'};
			return {status:'resolved',path:target.path,anchor:resolveSubpath(cache,request.fragment)?'resolved':'missing'};
		},
		linkCandidates:allVault?vaultCandidates:async request=>{
			const {lookup,missingLibraries,unavailableLibraries}=await (registeredCandidates??=loadRegisteredCandidates());
			return {paths:lookup(request),missingLibraries,unavailableLibraries};
		},
		linkCandidateScope:allVault?'vault':'registered',
	};
}

function statusInfo(status:string):{label:string;color:string;icon:string} {
	switch(status){
		case 'passed': return {label:tr('通过','Passed'),color:'passed',icon:'circle-check'};
		case 'error': return {label:tr('错误','Error'),color:'error',icon:'circle-x'};
		case 'failed': return {label:tr('运行失败','Failed'),color:'error',icon:'circle-x'};
		case 'warning': return {label:tr('警告','Warning'),color:'warning',icon:'triangle-alert'};
		case 'findings': return {label:tr('有发现','Findings'),color:'warning',icon:'triangle-alert'};
		case 'partial': return {label:tr('部分完成','Partial'),color:'partial',icon:'circle-dashed'};
		case 'info': return {label:tr('提示','Info'),color:'info',icon:'info'};
		case 'skipped': return {label:tr('已跳过','Skipped'),color:'neutral',icon:'circle-minus'};
		case 'cancelled': return {label:tr('已取消','Cancelled'),color:'neutral',icon:'circle-stop'};
		case 'not-run': return {label:tr('未运行','Not run'),color:'neutral',icon:'circle'};
		default: return {label:tr('尚未运行','Not run'),color:'neutral',icon:'circle'};
	}
}

function badge(parent:HTMLElement,status:string) {
	const {label,color,icon}=statusInfo(status);
	const item=parent.createSpan({cls:`kb-v3-status kb-v3-status-${color}`});
	const mark=item.createSpan({attr:{'aria-hidden':'true'}});
	setIcon(mark,icon);
	item.createSpan({text:label});
	return item;
}

function summaryStatus(parent:HTMLElement,status:string,diagnostics:readonly Diagnostic[]) {
	const highest=diagnostics.some(item=>item.severity==='error')?'error':diagnostics.some(item=>item.severity==='warning')?'warning':undefined;
	badge(parent,status==='findings' && highest ? highest : status);
	if(highest && status!=='findings' && status!=='failed')badge(parent,highest);
}

function coverage(parent:HTMLElement,value:Report['checks'][number]['coverage']) {
	const row=parent.createDiv({cls:'kb-v3-coverage'});
	const parts: [number,string][]=[[value.checked,tr('已检','Checked')],[value.skipped,tr('跳过','Skipped')],[value.unknown,tr('未验证','Unverified')]];
	for(const [count,label] of parts){
		const box=row.createDiv();
		box.createEl('strong',{text:String(count)});
		box.createSpan({text:label});
	}
	return row;
}

async function openDiagnostic(plugin:KnowledgeBaseManager,library:Library,item:Diagnostic) {
	if(!item.file)return;
	const relative=library.location+'/'+item.file;
	await plugin.disk.path(relative);
	const file=plugin.app.vault.getAbstractFileByPath(relative);
	if(!(file instanceof TFile))throw new Error(tr('找不到此文件','File not found')+' · '+relative);
	await plugin.app.workspace.getLeaf(false).openFile(file,item.line?{eState:{line:item.line-1}}:undefined);
}

function reportView(container:HTMLElement,report:Report,plugin:KnowledgeBaseManager,lib:Library,history?:ReportHistory) {
	container.empty();
	const results=container.createDiv({cls:'kb-v3-results'});
	const header=results.createDiv({cls:'kb-v3-report-heading'});
	header.createEl('h3',{text:tr('检验结果','Check results')});
	summaryStatus(header,report.status,report.checks.flatMap(check=>check.diagnostics));
	const total=report.checks.reduce((all,{coverage})=>({checked:all.checked+coverage.checked,skipped:all.skipped+coverage.skipped,unknown:all.unknown+coverage.unknown}),{checked:0,skipped:0,unknown:0});
	coverage(results,total);
	results.createEl('time',{cls:'kb-v3-muted',text:reportDate(report.startedAt),attr:{datetime:report.startedAt,title:report.startedAt}});
	if(report.logPath){
		const log=results.createEl('details',{cls:'kb-check-evidence'});
		log.createEl('summary',{text:tr('日志位置','Log file')});
		log.createEl('code',{cls:'kb-check-location',text:report.logPath});
	}
	if(report.logError)results.createEl('p',{cls:'kb-git-error',text:tr('日志保存失败','Could not save log')+' · '+report.logError});
	diagnosticReportDetails(results,report,checkName,history);
	if(report.status==='cancelled')results.createEl('p',{text:tr('已保留完成的检查结果。本次取消未写入历史。','Completed results are shown here. This cancelled run was not saved to history.')});
	const scope=results.createEl('details',{cls:'kb-v3-detail'});
	scope.open=report.status==='cancelled'||report.checks.some(check=>check.status==='partial'||check.status==='failed');
	scope.createEl('summary',{text:tr('各项检查范围','Coverage by check')});
	const group = crypto.randomUUID();
	for(const check of report.checks){
		const row=scope.createEl('details',{cls:'kb-check-result',attr:{name:group}});
		const summary=row.createEl('summary');
		summary.createEl('strong',{text:checkName(check.id,check.name)});
		summaryStatus(summary,check.status,check.diagnostics);
		summary.createSpan({cls:'kb-check-counts',text:tr('已检','Checked')+' '+check.coverage.checked+' · '+tr('跳过','Skipped')+' '+check.coverage.skipped+' · '+tr('未验证','Unverified')+' '+check.coverage.unknown});
		row.addEventListener('toggle',()=>{
			if(!row.open || row.childElementCount>1)return;
			const body=row.createDiv({cls:'kb-check-body'});
			if(check.reason)body.createEl('p',{text:check.reason});
			showCheckedItems(body,check);
			if(check.diagnostics.length){
				for(const item of check.diagnostics)finding(body,item);
			} else if(check.status==='passed' && !check.checkedItems?.length){
				body.createEl('p',{text:tr('已检查的项目均通过。','All checked items passed.')});
			} else if(!check.checkedItems?.length && (!check.reason || check.coverage.checked)){
				body.createEl('p',{text:tr('本项没有记录诊断消息。','This check recorded no diagnostic messages.')});
			}
			if(check.excludedPaths?.length){
				body.createEl('h5',{text:tr('扫描时排除的路径','Paths excluded from scanning')});
				const paths=body.createEl('ul');
				for(const path of check.excludedPaths)paths.createEl('li',{text:path});
				if(check.excludedPaths.length===40)body.createEl('p',{text:tr('最多列出 40 条路径。','Up to 40 paths are listed.')});
			}
			if(check.baseExpressions?.length){
				body.createEl('h5',{text:tr('需在 Obsidian 查看结果的表达式','Expressions to verify in Obsidian')});
				const entries=body.createEl('ul');
				for(const entry of check.baseExpressions){
					const li=entries.createEl('li');
					li.createEl('strong',{text:entry.scope});
					li.createSpan({text:' · '+entry.file+(entry.line ? ' · '+tr('第 ','Line ')+entry.line+tr(' 行','') : '')});
					li.createEl('code',{cls:'kb-check-location',text:entry.expression});
				}
				if(check.baseExpressionCount && check.baseExpressionCount>check.baseExpressions.length)
					body.createEl('p',{text:tr('已列出前 40 项，共 ','Showing the first 40 of ')+check.baseExpressionCount+tr(' 项。',' expressions.')});
			}
			if(check.coverage.skipped && !check.excludedPaths?.length)
				body.createEl('p',{cls:'kb-v3-muted',text:tr('此报告未单独列出跳过的条目。','This report does not list skipped entries individually.')});
		});
	}
	let severity:Severity|'' = '';
	const findings=report.checks.flatMap(check=>check.diagnostics.map(item=>({item,name:checkName(check.id,check.name)})));
	const list=results.createDiv({cls:'kb-v3-report-list'});
	new Setting(results).setName(tr('严重程度','Severity')).addDropdown(input=>{
		input.selectEl.setAttribute('aria-label',tr('严重程度','Severity'));
		input.addOptions({'':tr('全部','All'),error:tr('错误','Errors'),warning:tr('警告','Warnings'),info:tr('提示','Info')})
			.onChange(value=>{severity=value as Severity|'';render();});
	});
	results.append(list);
	function render(){
		list.empty();
		for(const level of ['error','warning','info'] as const){
			if(severity!==''&&severity!==level)continue;
			const group=findings.filter(({item})=>item.severity===level);
			if(!group.length)continue;
			const heading=list.createEl('h4');badge(heading,level);heading.createSpan({text:String(group.length)});
			for(const {item,name} of group)finding(list,item,name);
		}
		if(!list.childElementCount)list.createEl('p',{cls:'kb-v3-muted',text:tr('没有符合筛选条件的诊断。','No diagnostics match the filter.')});
	}
	function finding(parent:HTMLElement,item:Diagnostic,name?:string){
		const card=parent.createDiv({cls:'kb-v3-finding'});
		badge(card,item.severity);
		card.createEl('strong',{text:item.message});
		const location=[item.file,item.line,item.column].filter(v=>v!==undefined).join(':');
		if(item.file)card.createEl('code',{cls:'kb-check-location',text:location});
		if(item.field)card.createEl('p',{text:tr('字段','Field')+' · '+item.field});
		if(item.evidence)card.createEl('p',{text:tr('依据','Evidence')+' · '+item.evidence});
		card.createEl('small',{cls:'kb-v3-muted',text:[name,item.code].filter(Boolean).join(' · ')});
		if(item.file && plugin.app.vault.getAbstractFileByPath(lib.location+'/'+item.file) instanceof TFile)
			card.createEl('button',{text:tr('定位文件','Open file'),attr:{type:'button','aria-label':tr('定位文件','Open file')+' · '+location}}).addEventListener('click',()=>{
				void openDiagnostic(plugin,lib,item).catch((error:unknown)=>new Notice(String(error)));
			});
	}
	render();
}

export function exportDiagnosticRunner(plugin:KnowledgeBaseManager) {
	const dialog=new Dialog(plugin.app,tr('导出离线检验工具','Export offline check tool'));
	let destination='kb-check.cjs';
	dialog.text(tr('保存到（仓库相对路径）','Save to (vault-relative)'),destination,value=>{destination=value;});
	dialog.contentEl.createEl('pre').createEl('code',{text:'node kb-check.cjs --library "<library path>" --checks all'});
	dialog.action(tr('导出','Export'),async()=>{
		const relative=destination.trim();
		if(!relative.endsWith('.cjs'))throw new Error(tr('使用 .cjs 扩展名。','Use the .cjs extension.'));
		const output=await plugin.disk.path(relative);
		try {await writeFile(output,offlineRunner(),{encoding:'utf8',flag:'wx'});}
		catch(error){
			if(error instanceof Error && 'code' in error && error.code==='EEXIST')
				throw new Error(tr('目标已存在，请选择其他保存路径。','The destination exists. Choose another path.')+' · '+relative);
			throw new Error(tr('无法写入离线检验工具。','Could not write the offline check tool.')+'\n'+String(error));
		}
		new Notice(tr('离线检验工具已导出','Offline check tool exported')+' · '+relative);
		dialog.close();
	}).setCta();
	dialog.open();
}

const activeDialogs=new WeakMap<KnowledgeBaseManager,Set<HealthDialog>>();

class HealthDialog extends V3Dialog {
	readonly lifetime=new AbortController();
	private opened=false;
	private readonly peers:Set<HealthDialog>;

	constructor(plugin:KnowledgeBaseManager){
		super(plugin.app,tr('检验知识库','Check library'));
		let peers=activeDialogs.get(plugin);
		if(!peers){
			const dialogs=new Set<HealthDialog>();
			activeDialogs.set(plugin,dialogs);
			plugin.register(()=>{for(const dialog of dialogs)dialog.dispose();});
			peers=dialogs;
		}
		this.peers=peers;
		peers.add(this);
	}
	onOpen(){this.opened=true;}
	onClose(){
		this.opened=false;
		this.dispose();
		super.onClose();
	}
	dispose(){
		this.lifetime.abort();
		this.peers.delete(this);
		if(this.opened)this.close();
	}
}

export async function checkLibrary(plugin:KnowledgeBaseManager,lib:Library) {
	const dialog=new HealthDialog(plugin);
	const lifetime=dialog.lifetime.signal;
	let root:string;
	try {root=await plugin.disk.path(lib.location);}
	catch(error){dialog.dispose();throw error;}
	if(lifetime.aborted)return;
	dialog.modalEl.addClass('kb-v3-health');
	const template=lib.identity?.template;
	dialog.facts([[tr('范围','Scope'),lib.location],[tr('模板','Template'),template?
		`${templateIdentityLabel(template.id)} · ${template.version}`:tr('未知','Unknown')]]);
	const tabs=createPanelTabs(dialog.contentEl,tr('检验面板','Library checks'),[
		{id:'run',label:tr('运行检验','Run checks')},{id:'history',label:tr('历史报告','History')},{id:'tools',label:tr('检验工具','Tools')},
	] as const,'run',page=>{if(page==='history')void loadHistory();else history?.abort();});
	const selected=new Set<string>();
	const official=officialCheckDigests();
	const commonSources=commonRuleSources();
	let installed=false;
	let running:AbortController|undefined;
	let history:AbortController|undefined;
	let knownTemplateChecks:Options['knownTemplateChecks'];
	let choiceRequest=0;
	lifetime.addEventListener('abort',()=>{running?.abort();history?.abort();},{once:true});
	let custom=false;
	let generalCount=0;
	let templateCount=0;
	let hasPortability=false;
	let allVaultCandidates=false;
	let candidateScope:HTMLDivElement|undefined;
	const controls:ButtonComponent[]=[];
	const form=tabs.panels.run.createDiv();
	dialogContents(form).choice(tr('检查范围','Checks to run'),
		{all:tr('常规与模板专项','General and template checks'),custom:tr('自选检查项','Choose individual checks')},
		value=>{custom=value==='custom';update();});
	const guidance=form.createEl('p',{cls:'kb-v3-muted',attr:{role:'status'}});
	const choices=form.createDiv();
	const runActions=form.createDiv({cls:'kb-v3-check-actions'});
	const errorEl=form.createEl('p',{cls:'kb-git-error',attr:{role:'alert'}});
	errorEl.hidden=true;
	const runButton=new ButtonComponent(runActions).setButtonText(tr('开始检验','Start check')).setCta().onClick(()=>{
		void run(custom?[...selected]:'all').catch((e:unknown)=>{
			if(!lifetime.aborted){errorEl.hidden=false;errorEl.setText(String(e));}
		});
	});
	const cancel=new ButtonComponent(runActions).setButtonText(tr('取消检验','Cancel check')).onClick(()=>{
		running?.abort();update();
	});
	const output=tabs.panels.run.createDiv({cls:'kb-v3-check-output',attr:{'aria-live':'polite'}});
	const back=new ButtonComponent(tabs.panels.run).setButtonText(tr('重新选择检查项','Choose checks again')).onClick(()=>{
		output.empty();form.hidden=false;back.buttonEl.hidden=true;update();form.querySelector('select')?.focus();
	});
	back.buttonEl.hidden=true;
	const tools=tabs.panels.tools;
	const info=tools.createEl('p');
	const updateRow=new Setting(tools).setName(tr('本库检验工具','Installed check kit')).addButton(b=>b
		.setButtonText(tr('查看版本与差异','Review version and changes')).onClick(()=>{void showCheckKitUpdate(plugin,lib.location,renderChoices).catch((e:unknown)=>new Notice(String(e)));}));
	new Setting(tools).setName(tr('导出离线入口','Export offline runner')).addButton(b=>b.setButtonText(tr('选择保存位置','Choose a destination')).onClick(()=>exportDiagnosticRunner(plugin)));
	async function loadHistory(){
		history?.abort();
		const request=new AbortController();
		history=request;
		const panel=tabs.panels.history;
		panel.empty();
		panel.createEl('p',{text:tr('正在读取报告…','Loading reports…')});
		try {
			const reports=await listDiagnosticHistory(root,request.signal);
			if(request.signal.aborted)return;
			panel.empty();
			if(!reports.length)panel.createEl('p',{text:tr('尚无检验报告。运行一次检验后可在这里查看。','Run a check to see its report here.')});
			for(const [index,report] of reports.entries()){
				const date=reportDate(report.startedAt),reference=report.logPath??report.runId;
				const row=new Setting(panel).setName(date).setDesc(reference);
				badge(row.nameEl,report.status);
				row.addButton(b=>{
					b.buttonEl.setAttribute('aria-label',tr('查看报告','View report')+' · '+date+' · '+reference);
					b.setButtonText(tr('查看报告','View report')).onClick(()=>{
						panel.empty();
						new ButtonComponent(panel).setButtonText(tr('返回历史列表','Back to history')).onClick(()=>{void loadHistory();});
						reportView(panel.createDiv(),report,plugin,lib,{
							previous:reports.slice(index+1),signal:request.signal,
							freshness:()=>diagnosticFreshness({libraryRoot:root,vaultRoot:plugin.disk.root,configDir:plugin.disk.configDir,signal:request.signal},report),
						});
					});
				});
			}
		} catch(e){if(!request.signal.aborted)panel.setText(String(e));}
	}
	function display(report:Report){
		reportView(output,report,plugin,lib);form.hidden=true;back.buttonEl.hidden=false;
		output.querySelector('h3')?.setAttribute('tabindex','-1');
		if(tabs.getActive()==='run')output.querySelector('h3')?.focus();
	}
	function update(){
		runButton.setDisabled(!!running||(custom&&!selected.size));
		runButton.setButtonText(running?tr('正在检验…','Running…'):tr('开始检验','Start check'));
		cancel.buttonEl.hidden=!running;
		cancel.setDisabled(running?.signal.aborted ?? false);
		cancel.setButtonText(running?.signal.aborted ? tr('正在取消…','Cancelling…') : tr('取消检验','Cancel check'));
		for(const control of controls) control.setDisabled(!!running);
		form.querySelectorAll('input,select').forEach(field=>{(field as HTMLInputElement).disabled=!!running;});
		choices.hidden=!custom;
		if(candidateScope)candidateScope.hidden=!selected.has(portabilityCheck.id);
		const summaries=custom?[tr(`已选 ${selected.size} 项。可选 ${generalCount} 项通用检验和 ${templateCount} 项模板专项。`,
			`Selected ${selected.size}. Choose from ${generalCount} general checks and ${templateCount} template checks.`)]:
			[tr(`默认范围包含 ${generalChecks.length} 项常规检验和 ${templateCount} 项模板专项。`,
				`The default scope includes ${generalChecks.length} general checks and ${templateCount} template checks.`)];
		if(!custom && hasPortability)summaries.push(tr('如需检验可移植性，请切换到“自选检查项”并勾选。','To check portability, switch to Choose individual checks and select Portability.'));
		if(!custom && controls.length)summaries.push(tr('可在“自选检查项”中审查并授权脚本。','Choose individual checks to review and approve scripts.'));
		const summary=summaries.join(tr('',' '));
		if(guidance.textContent!==summary)guidance.setText(summary);
		updateRow.settingEl.hidden=!installed;
		info.setText(installed?tr('本库 README 中有离线命令。规则和运行入口位于 checks/。','The library README contains the offline command. Its runner and rules are in checks/.'):
			tr('此库沿用内置通用检验。可导出独立入口供命令行使用。','This library uses built-in general checks. Export a runner for command-line use.'));
	}
	async function renderChoices(){
		if(lifetime.aborted)return;
		const request=++choiceRequest;
		choices.empty();controls.length=0;candidateScope=undefined;
		const [common,special]=await Promise.all([listCommonChecks(root,lifetime),listSpecialChecks(root,lifetime)]).catch((error:unknown)=>{
			if(lifetime.aborted)return [];
			throw error;
		});
		if(lifetime.aborted||request!==choiceRequest||!common||!special)return;
		installed=common.mode==='kit';
		knownTemplateChecks=special.checks;
		const general=installed?common.checks:[...generalChecks,portabilityCheck];
		generalCount=general.length;
		templateCount=special.checks.length;
		hasPortability=general.some(check=>check.id===portabilityCheck.id);
		const approved=trustedDigests(plugin);
		const specialSources=packText(special.template?.id ?? '');
		for(const id of selected)if(![...general,...special.checks].some(check=>check.id===id))selected.delete(id);
		for(const [label,items,isCommon,reason] of [[tr('通用检验','General checks'),general,true,common.reason],
			[tr('模板专项','Template checks'),special.checks,false,special.reason]] as const){
			choices.createEl('h3',{text:label});
			if(reason || !items.length)choices.createEl('p',{cls:'kb-v3-muted',text:reason ?? (isCommon ?
				tr('没有可用的通用检验。','No general checks are available.') : tr('没有已声明的专项检验。','No template checks declared.'))});
			for(const check of items){
				const item=choices.createDiv({cls:'kb-v3-check-choice-row'});
				const row=item.createEl('label',{cls:'kb-v3-check-choice'});
				const input=row.createEl('input',{type:'checkbox'});
				input.checked=selected.has(check.id);
				input.addEventListener('change',()=>{if(input.checked)selected.add(check.id);else selected.delete(check.id);update();});
				const name=isCommon?checkName(check.id,check.name):check.name;
				row.createSpan({text:name});
				if('path' in check){
					const spec=check;
					const bundled=isCommon?commonCheckTrusted(spec):!!spec.digest && official.includes(spec.digest);
					const trusted=!!spec.digest && approved.includes(spec.digest);
					const trust=bundled?tr('官方版本','Official version'):trusted?tr('已授权','Approved'):tr('需授权此版本','Approval required');
					row.title=spec.path+' · '+trust;
					if(spec.description || spec.reason || !bundled)row.createSpan({cls:'kb-v3-muted',text:[spec.description,spec.reason ?? (bundled?'':trust)].filter(Boolean).join(' · ')});
					if(spec.digest && !bundled){
						const review=new ButtonComponent(item).setButtonText(tr('审查脚本','Review script')).onClick(async()=>{
							try {await reviewDiagnosticScript(plugin,lib.location,spec,(isCommon?commonSources:specialSources)[spec.path],renderChoices);}
							catch(error){new Notice(String(error));}
						});
						review.buttonEl.setAttribute('aria-label',tr('审查脚本','Review script')+' · '+name+' · '+spec.path);
						review.buttonEl.addClass('kb-v3-script-review');controls.push(review);
					}
				}
				if(check.id===portabilityCheck.id){
					row.createSpan({cls:'kb-v3-muted',text:tr('检查移动或克隆本库时可能失效的引用。默认在当前库及已登记库中查找同名候选。','Check for references that may break when moving or cloning this library. By default, look for same-name candidates in the current and registered libraries.')});
					candidateScope=choices.createDiv();
					const scopeRow=candidateScope.createEl('label',{cls:'kb-v3-check-choice'});
					const scopeInput=scopeRow.createEl('input',{type:'checkbox'});
					scopeInput.checked=allVaultCandidates;
					scopeInput.addEventListener('change',()=>{allVaultCandidates=scopeInput.checked;});
					scopeRow.createSpan({text:tr('在整个仓库查找同名候选','Look for same-name candidates across the vault')});
				}
			}
		}
		update();
	}
	async function run(checks:readonly string[]|'all'){
		if(running||lifetime.aborted)return;
		running=new AbortController();
		const {signal}=running;
		errorEl.hidden=true;errorEl.empty();update();
		output.empty();
		output.createEl('p',{text:tr('正在检验…','Running checks…'),attr:{role:'status'}});
		try{
			const registry=await readVaultRegistry(plugin.disk).catch(()=>undefined);
			if(lifetime.aborted)return;
			const report=await runDiagnostics({libraryRoot:root,vaultRoot:plugin.disk.root,configDir:plugin.disk.configDir,
				registered:registry?.paths.includes(lib.location),registeredPaths:registry?.paths,duplicate:lib.duplicate,selected:checks,signal,knownTemplateChecks,
				trustedDigests:trustedDigests(plugin),officialDigests:official,...linkOptions(plugin,lib.location,registry?.paths ?? [],allVaultCandidates,signal)});
			if(!lifetime.aborted)display(report);
		} catch(error) {
			if(!lifetime.aborted)output.empty();
			throw error;
		} finally {running=undefined;if(!lifetime.aborted)update();}
	}
	try {
		await renderChoices();
		if(!lifetime.aborted)dialog.open();
	} catch(error) {
		if(!lifetime.aborted){dialog.dispose();throw error;}
	}
}
