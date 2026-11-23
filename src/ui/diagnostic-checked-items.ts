import type {CheckedItem, Diagnostic, DiagnosticCheckResult} from '../diagnostics/types.ts';
import {tr} from '../i18n.ts';

export function showCheckedItems(parent: HTMLElement, check: DiagnosticCheckResult,
	sourceLink:(parent:HTMLElement,file:string,line?:number)=>void) {
	const total = check.coverage.checked;
	if (!total) return;
	parent.createEl('h5',{text:tr('已检明细','Checked items')+' · '+total});
	const rows = check.checkedItems ?? [];
	if (!rows.length) {
		parent.createEl('p',{cls:'kb-v3-muted',text:tr('此报告只记录了已检数量，没有保存逐项明细。','This report recorded the checked count without individual results.')});
		if (check.rule?.path) parent.createEl('code',{cls:'kb-check-location',text:tr('本次规则','Rule used')+' · '+check.rule.path});
		return;
	}
	const list = parent.createEl('ol',{cls:'kb-checked-items'});
	const byFile = new Map<string,Diagnostic[]>();
	for (const finding of check.diagnostics) {
		if (!finding.file) continue;
		const previous = byFile.get(finding.file);
		if (previous) previous.push(finding);
		else byFile.set(finding.file,[finding]);
	}
	// A file or line can contain several checks. Only attach a finding's color
	// when the recorded message or field identifies this particular result.
	function outcomeColor(row:CheckedItem) {
		const findings = byFile.get(row.file) ?? [];
		const matched = findings.filter(finding =>
			(finding.line === undefined || row.line === undefined || finding.line === row.line) &&
			(finding.message === row.outcome || (finding.field && row.subject.startsWith(finding.field+' · '))));
		for (const level of ['error','warning','info'] as const) {
			if (matched.some(finding=>finding.severity === level)) return level;
		}
		if (check.status === 'passed' && !findings.length) return 'passed';
		// Bundled Bases emits checked rows for static tests and separately lists
		// dynamic expressions. A partial report can contain successful static tests.
		if (check.id === 'bases' && check.rule?.engine === 'bundled' && !findings.length &&
			(check.status === 'partial' || check.status === 'findings')) return 'passed';
		return undefined;
	}
	const more = rows.length > 50 ? parent.createEl('button',{text:tr('再显示 50 条','Show 50 more'),attr:{type:'button'}}) : undefined;
	let next = 0;
	function appendPage() {
		for (const row of rows.slice(next,next+50)) {
			const li = list.createEl('li');
			li.createEl('strong',{text:row.subject});
			sourceLink(li,row.file,row.line);
			const amount = row.count && row.count>1 ? ' · '+row.count+tr(' 项',' items') : '';
			const result=li.createDiv({text:tr('结果','Result')+' · '});
			const color=outcomeColor(row);
			result.createSpan({cls:color ? 'kb-v3-status-'+color : undefined,text:row.outcome+amount});
			next++;
		}
		if (next >= rows.length) more?.remove();
	}
	appendPage();
	more?.addEventListener('click',appendPage);
	const recorded = rows.reduce((n,row)=>n+(row.count ?? 1),0);
	if (recorded < total) parent.createEl('p',{cls:'kb-v3-muted',text:tr('另有 ','Individual results were not saved for ')+(total-recorded)+tr(' 项未保存明细。',' additional items.')});
}
