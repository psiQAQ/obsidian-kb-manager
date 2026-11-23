import type {DiagnosticCheckResult} from '../diagnostics/types.ts';
import {tr} from '../i18n.ts';

export function showCheckedItems(parent: HTMLElement, check: DiagnosticCheckResult) {
	const total = check.coverage.checked;
	if (!total) return;
	parent.createEl('h5',{text:tr('已检明细','Checked items')+' · '+total});
	const rows = check.checkedItems ?? [];
	if (!rows.length) {
		parent.createEl('p',{cls:'kb-v3-muted',text:tr('此报告只记录了已检数量，没有保存逐项明细。','This report recorded the checked count without individual results.')});
		return;
	}
	const list = parent.createEl('ol',{cls:'kb-checked-items'});
	const more = rows.length > 50 ? parent.createEl('button',{text:tr('再显示 50 条','Show 50 more'),attr:{type:'button'}}) : undefined;
	let next = 0;
	function appendPage() {
		for (const row of rows.slice(next,next+50)) {
			const li = list.createEl('li');
			li.createEl('strong',{text:row.subject});
			const source = row.file + (row.line ? ' · '+tr('第 ','Line ')+row.line+tr(' 行','') : '');
			li.createEl('code',{cls:'kb-check-location',text:source});
			const amount = row.count && row.count>1 ? ' · '+row.count+tr(' 项',' items') : '';
			li.createDiv({text:tr('结果','Result')+' · '+row.outcome+amount});
			next++;
		}
		if (next >= rows.length) more?.remove();
	}
	appendPage();
	more?.addEventListener('click',appendPage);
	const recorded = rows.reduce((n,row)=>n+(row.count ?? 1),0);
	if (recorded < total) parent.createEl('p',{cls:'kb-v3-muted',text:tr('另有 ','Individual results were not saved for ')+(total-recorded)+tr(' 项未保存明细。',' additional items.')});
}
