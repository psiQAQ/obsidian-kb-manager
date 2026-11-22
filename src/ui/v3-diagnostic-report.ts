import {ButtonComponent} from 'obsidian';
import {compareDiagnosticReports} from '../diagnostics/comparison.ts';
import type {DiagnosticFreshness} from '../diagnostics/provenance.ts';
import type {DiagnosticReport} from '../diagnostics/types.ts';
import {tr} from '../i18n.ts';
import {dialogContents} from './dialog.ts';

type CheckName = (id:string,name:string)=>string;
export interface ReportHistory {
	previous:readonly DiagnosticReport[];
	freshness:()=>Promise<DiagnosticFreshness>;
	signal:AbortSignal;
}

export function reportDate(value:string) {
	const date=new Date(value);
	return Number.isNaN(date.getTime())?value:date.toLocaleString();
}

export function diagnosticReportDetails(parent:HTMLElement,report:DiagnosticReport,checkName:CheckName,history?:ReportHistory) {
	const metadata=parent.createEl('details',{cls:'kb-v3-detail'});
	metadata.createEl('summary',{text:tr('规则与输入版本','Rule and input versions')});
	if(!report.engineVersion && !report.inputVersion) {
		metadata.createEl('p',{text:tr('此报告未记录版本信息。','This report has no version information.')});
	}
	if(report.engineVersion)metadata.createEl('p',{text:tr('检验引擎','Check engine')+' · '+report.engineVersion});
	if(report.inputVersion){
		const entry=metadata.createEl('p',{text:tr('输入版本','Input version')+' · '});
		entry.createEl('code',{text:report.inputVersion.fingerprint});
	}
	for(const check of report.checks){
		if(!check.rule)continue;
		const {engine,version,path,digest}=check.rule;
		const source=engine==='legacy'?tr('内置旧库检验','Built-in legacy check'):
			engine==='bundled'?tr('随版官方规则','Bundled official rule'):tr('本机 Node.js 脚本','Local Node.js script');
		const row=metadata.createDiv({cls:'kb-check-scope'});
		row.createEl('strong',{text:checkName(check.id,check.name)});
		row.createSpan({text:source+' · '+version});
		if(path)row.createEl('code',{cls:'kb-check-location',text:path});
		if(digest)row.createEl('code',{cls:'kb-check-location',text:digest});
	}
	if(!history)return;
	const {signal,freshness:getFreshness}=history;
	const status=parent.createDiv();
	const value=status.createSpan({attr:{role:'status'}});
	const refresh=new ButtonComponent(status).setButtonText(tr('核对当前文件','Verify current files')).onClick(()=>{void refreshFreshness();});
	const labels={
		fresh:tr('已核对的库内输入版本一致','Recorded library inputs are current'),
		stale:tr('报告已过期，请重新检验','Report is stale. Run the checks again.'),
		unknown:tr('无法核实报告的输入版本','Report input version could not be verified'),
	};
	async function refreshFreshness(){
		if(signal.aborted)return;
		refresh.setDisabled(true);
		value.setText(tr('正在核对报告版本…','Verifying report version…'));
		let freshness:DiagnosticFreshness='unknown';
		try {freshness=await getFreshness();}
		catch {if(signal.aborted)return;}
		if(signal.aborted)return;
		value.setText(labels[freshness]);
		refresh.setDisabled(false);
	}
	void refreshFreshness();
	if(history.previous.length)comparison(parent,report,history.previous,checkName);
}

function comparison(parent:HTMLElement,current:DiagnosticReport,previous:readonly DiagnosticReport[],checkName:CheckName) {
	const detail=parent.createEl('details',{cls:'kb-v3-detail'});
	detail.createEl('summary',{text:tr('与早先报告比较','Compare with an earlier report')});
	const selected=new Map(previous.map(report=>[report.runId,report]));
	const names=new Map([...previous.flatMap(report=>report.checks), ...current.checks].map(check=>[check.id,checkName(check.id,check.name)]));
	dialogContents(detail).choice(tr('基准报告','Earlier report'),Object.fromEntries(
		previous.map(report=>[report.runId,reportDate(report.startedAt)+' · '+report.runId.slice(0,8)]),
	),id=>{const baseline=selected.get(id);if(baseline)render(baseline);});
	const output=detail.createDiv({attr:{'aria-live':'polite'}});
	function render(baseline:DiagnosticReport){
		output.empty();
		const {introduced,resolved,remaining,unavailableChecks,changedRules}=compareDiagnosticReports(baseline,current);
		const named=(ids:string[])=>ids.map(id=>names.get(id)??id).join(tr('、',', '));
		if(unavailableChecks.length)output.createEl('p',{text:tr('缺少可比的完整结果','Checks without comparable complete results')+' · '+named(unavailableChecks)});
		if(changedRules.length)output.createEl('p',{text:tr('规则版本有变化','Rule versions changed')+' · '+named(changedRules)});
		for(const [label,items] of [[tr('新增','New'),introduced],[tr('已解决','Resolved'),resolved],[tr('仍存在','Still present'),remaining]] as const){
			const group=output.createEl('details',{cls:'kb-check-evidence'});
			group.createEl('summary',{text:label+' · '+items.length});
			if(!items.length)continue;
			const list=group.createEl('ul');
			for(const {checkId,diagnostic} of items){
				const location=diagnostic.file ? diagnostic.file+(diagnostic.line ? ':'+diagnostic.line : '') : undefined;
				list.createEl('li',{text:[names.get(checkId)??checkId,location,diagnostic.message].filter(Boolean).join(' · ')});
			}
		}
	}
	render(previous[0]!);
}
