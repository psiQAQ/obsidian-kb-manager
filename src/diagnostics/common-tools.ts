import {createCheckedRecorder} from './checked-items.ts';
import type {LinkPlaceholder} from './placeholders.ts';
import type {Diagnostic, DiagnosticCheckResult} from './types.ts';

export function recordLinkPlaceholder(check: DiagnosticCheckResult, placeholder: LinkPlaceholder,
	position: Pick<Diagnostic,'file'|'line'|'evidence'>, showFinding = true) {
	check.coverage[placeholder.coverage]++;
	if (!showFinding) return;
	const evidence = [position.evidence, placeholder.diagnostic.evidence].filter(Boolean).join(' · ');
	check.diagnostics.push({...position,...placeholder.diagnostic,evidence:evidence || undefined});
}

// Formatting helpers for the verified common rule protocol.
export const commonToolsSource = String.raw`
const addReason = (result, reason) => {
	if (result.reason?.includes(reason)) return false;
	result.reason = result.reason ? result.reason + ' ' + reason : reason;
	return true;
};
const validText = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
function commonTools(chinese) {
	const tr = (zh, en) => chinese ? zh : en;
	const recordChecked = (${createCheckedRecorder.toString()})();
const recordLinkPlaceholder = (${recordLinkPlaceholder.toString()});
	return {tr, addReason, validText, recordChecked, recordLinkPlaceholder};
}
`;
