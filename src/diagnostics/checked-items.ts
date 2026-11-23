import {relativePath} from './snapshot.ts';
import {isRecord} from './types.ts';
import type {CheckedItem, DiagnosticCheckResult} from './types.ts';

// Also serialized into the isolated Node runner. Keep this factory self-contained.
export function createCheckedRecorder() {
	const sizes = new WeakMap<DiagnosticCheckResult,number>();
	function label(value: string) {
		return value.length > 512 ? value.slice(0,511) + '…' : value;
	}
	return function recordChecked(check: DiagnosticCheckResult, file: string, subject: string, outcome: string, line?: number, count = 1) {
		if (!count) return;
		check.coverage.checked += count;
		const items = check.checkedItems ??= [];
		const size = sizes.get(check) ?? 0;
		if (items.length >= 4000 || size >= 256 * 1024) return;
		const item: CheckedItem = {file,subject:label(subject),outcome:label(outcome)};
		if (line !== undefined) item.line = line;
		if (count !== 1) item.count = count;
		items.push(item);
		sizes.set(check,size + file.length + item.subject.length + item.outcome.length + 80);
	};
}

export const recordChecked = createCheckedRecorder();

/** Optional evidence from editable rules and saved reports. Only admit the documented fields. */
export function readCheckedItems(value: unknown): CheckedItem[] | undefined {
	if (!Array.isArray(value) || value.length > 4000) return;
	const rows: CheckedItem[] = [];
	for (const item of value as unknown[]) {
		if (!isRecord(item) || !relativePath(item.file) || typeof item.subject !== 'string' || !item.subject.trim() ||
			item.subject.length > 512 || typeof item.outcome !== 'string' || !item.outcome.trim() || item.outcome.length > 512) return;
		const row: CheckedItem = {file:item.file,subject:item.subject,outcome:item.outcome};
		for (const key of ['line','count'] as const) {
			const number = item[key];
			if (number === undefined) continue;
			if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return;
			row[key] = number;
		}
		rows.push(row);
	}
	return rows;
}
