import type { StructuredPatchHunk } from 'diff';
import { tr } from '../i18n.ts';
import { numberedLines, pairedLines } from './diff-lines.ts';
import type { PatchLine } from './diff-lines.ts';

const batchSize=300;

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
	const controls=parent.createDiv({cls:'kb-diff-controls'});
	const previous=controls.createEl('button',{text:tr('上一差异处','Previous difference'),attr:{type:'button'}});
	const next=controls.createEl('button',{text:tr('下一差异处','Next difference'),attr:{type:'button'}});
	const position=controls.createSpan({attr:{role:'status'}});
	const layout=controls.createEl('button',{attr:{type:'button'}});
	const start=controls.createEl('button',{text:tr('从头显示差异','Show diff from start'),attr:{type:'button'}});
	const result=parent.createDiv();
	let current=-1;
	let first=0;
	let table=renderTable(result,hunks,split,left,right,first,initialRows);
	const redraw=(at:number)=>{
		const horizontal=table.viewport.scrollLeft;
		result.empty();first=at;
		table=renderTable(result,hunks,split,left,right,first,batchSize);
		table.viewport.scrollLeft=horizontal;
	};
	const mark=(index:number,scroll:boolean)=>{
		if(!table.ranges.has(index))redraw(index);
		const row=table.ranges.get(index);
		if(!row)return;
		table.body.querySelector('.kb-diff-current')?.removeClass('kb-diff-current');
		row.addClass('kb-diff-current');
		if(scroll)row.scrollIntoView({block:'center',inline:'nearest'});
	};
	const update=()=>{
		layout.setText(split?tr('统一视图','Unified view'):tr('双栏视图','Side-by-side view'));
		position.setText(current<0?tr('差异块','Hunks')+' · '+hunks.length:(current+1)+' / '+hunks.length);
		start.hidden=first===0;
	};
	const jump=(step:number)=>{
		current=current<0?(step>0?0:hunks.length-1):(current+step+hunks.length)%hunks.length;
		mark(current,true);update();
	};
	previous.onclick=()=>jump(-1);
	next.onclick=()=>jump(1);
	start.onclick=()=>{current=-1;redraw(0);update();};
	layout.onclick=()=>{
		split=!split;
		redraw(current<0?first:current);
		if(current>=0)mark(current,true);
		update();
	};
	update();
}

function renderTable(parent: HTMLElement, hunks: StructuredPatchHunk[], split: boolean, left: string, right: string, first: number, initialRows: number) {
	const viewport = parent.createDiv({cls:'kb-diff-scroll'});
	const table = viewport.createEl('table', {cls:'kb-diff-table ' + (split ? 'kb-diff-split' : 'kb-diff-unified')});
	const header = table.createEl('thead').createEl('tr');
	for (const label of split ? [left,right] : [left + ' → ' + right]) header.createEl('th', {text:label, attr:{scope:'col'}});
	const body = table.createEl('tbody');

	// Bound the initial DOM even when a small file has many short lines.
	function* rows() {
		for(let index=first;index<hunks.length;index++){
			const range=hunks[index]!;
			yield {range,index};
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
	const ranges=new Map<number,HTMLTableRowElement>();
	const more = parent.createEl('button', {text:tr('显示更多差异行','Show more diff lines')});
	const appendBatch = (size:number) => {
		for (let i = 0; i < size && !next.done; i++, next = iterator.next()) {
			const {range,index,before,after} = next.value, row = body.createEl('tr');
			if (range) {
				ranges.set(index,row);
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
	more.onclick = () => appendBatch(batchSize);
	appendBatch(Math.max(batchSize,initialRows));
	return {viewport,body,ranges};
}
