import type { StructuredPatchHunk } from 'diff';
import { tr } from '../i18n.ts';
import { numberedLines, pairedLines } from './diff-lines.ts';
import type { PatchLine } from './diff-lines.ts';

function appendLine(row: HTMLElement, line: PatchLine | undefined, side: 'left' | 'right' | 'both') {
	const cell = row.createEl('td', {cls: 'kb-diff-cell'});
	if (!line) return;
	cell.addClass('kb-diff-' + line.kind);
	const grid = cell.createDiv({cls:'kb-diff-line'});
	if (side !== 'right') grid.createSpan({cls:'kb-diff-number', text:String(line.oldNumber ?? '')});
	if (side !== 'left') grid.createSpan({cls:'kb-diff-number', text:String(line.newNumber ?? '')});
	grid.createSpan({cls:'kb-diff-sign', text:line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '});
	const code = grid.createEl('code', {text:line.text.replace(/\r$/u, '')});
	if (line.text.endsWith('\r')) code.createSpan({cls:'kb-diff-eol', text:' CRLF'});
	if (line.noNewline) code.createSpan({cls:'kb-diff-eol', text:tr(' 末尾无换行',' No newline at end of file')});
}

export function renderDiff(parent: HTMLElement, hunks: StructuredPatchHunk[], split: boolean, left: string, right: string, initialRows: number) {
	const viewport = parent.createDiv({cls:'kb-diff-scroll'});
	const table = viewport.createEl('table', {cls:'kb-diff-table ' + (split ? 'kb-diff-split' : 'kb-diff-unified')});
	const header = table.createEl('thead').createEl('tr');
	for (const label of split ? [left,right] : [left + ' → ' + right]) header.createEl('th', {text:label, attr:{scope:'col'}});
	const body = table.createEl('tbody');

	// Bound the initial DOM even when a small file has many short lines.
	function* rows() {
		for (const range of hunks) {
			yield {range};
			const lines = numberedLines(range);
			if (split) {
				for (const [before,after] of pairedLines(lines)) yield {before,after};
			} else {
				for (const before of lines) yield {before};
			}
		}
	}
	const iterator = rows();
	let next = iterator.next();
	const more = parent.createEl('button', {text:tr('显示更多差异行','Show more diff lines')});
	const appendBatch = (size:number) => {
		for (let i = 0; i < size && !next.done; i++, next = iterator.next()) {
			const {range,before,after} = next.value, row = body.createEl('tr');
			if (range) {
				const {oldStart,oldLines,newStart,newLines} = range;
				row.createEl('td', {cls:'kb-diff-range', text:
					'@@ -' + oldStart + ',' + oldLines + ' +' + newStart + ',' + newLines + ' @@'}).colSpan = split ? 2 : 1;
			} else if (split) {
				appendLine(row,before,'left');
				appendLine(row,after,'right');
			} else {
				appendLine(row,before,'both');
			}
		}
		if (next.done) more.remove();
	};
	more.onclick = () => appendBatch(300);
	appendBatch(Math.max(300,initialRows));
}
