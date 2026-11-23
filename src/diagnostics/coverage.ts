import {tr} from '../i18n.ts';
import type {Inventory} from './snapshot.ts';
import type {DiagnosticCheckResult} from './types.ts';

export function addReason(check: DiagnosticCheckResult, reason: string) {
	if (check.reason?.includes(reason)) return false;
	check.reason = check.reason ? check.reason + ' ' + reason : reason;
	return true;
}

export function reportInventoryCoverage(check: DiagnosticCheckResult, inventory: Inventory) {
	check.coverage.skipped += inventory.skipped;
	if (inventory.excluded.size) {
		check.excludedPaths = [];
		for (const path of inventory.excluded) {
			check.excludedPaths.push(path.length > 2048 ? path.slice(0,2047) + '…' : path);
			if (check.excludedPaths.length === 40) break;
		}
	}
	reportUnreadableDirectories(check, inventory);
}

export function reportUnreadableDirectories(check: DiagnosticCheckResult, inventory: Inventory) {
	if (!inventory.unreadableDirectories.size) return;
	check.coverage.unknown += inventory.unreadableDirectories.size;
	const message = tr('未能扫描目录中的文件。','Could not scan the files in the directory.');
	for (const file of inventory.unreadableDirectories)
		check.diagnostics.push({severity:'info', code:'unreadable-directory', file, message});
	addReason(check, tr('部分目录无法遍历。','Some directories could not be scanned.'));
}

export function reportUnreadableNotes(check: DiagnosticCheckResult, inventory: Inventory, includes: (file: string) => boolean = () => true) {
	const unreadable = inventory.unreadable.filter(includes);
	if (!unreadable.length) return;
	check.coverage.unknown += unreadable.length;
	const message = tr('Markdown 文件不可读或超出扫描限制。','Could not read the Markdown file within the scan limits.');
	for (const file of unreadable)
		check.diagnostics.push({severity:'info', code:'unreadable-note', file, message});
	addReason(check, tr('部分 Markdown 文件未能读取。','Some Markdown files could not be read.'));
}
