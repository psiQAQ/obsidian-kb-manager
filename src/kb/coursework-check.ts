import {isMap, isScalar, isSeq, parseDocument} from 'yaml';
import {declaration} from './template-declaration.ts';

export const courseworkTemplate = 'coursework';
export const courseworkScript = 'checks/workflow.mjs';
export const courseworkDeclaration = 'kb-template.json';
export const previousCourseworkDigests = [
	'0c99583d7a3ce38b741ed3981ad808e77af7da3ad9bff6300461e3a56f448601', // v1
	'9dafdf6d9f9c35aee095e8671fb6abd123fc8d2275781e25c3b363e828492e13', // v2 and v3
	'f3171fca91b4a58833a4b4246ce25ce8f34999ce4ca90e43c89456470e6cd4e9', // v4 before checked items
];

export function courseworkLinkDeclaration(raw: string, version: string): string | undefined {
	const source = raw.replace(/^\uFEFF/u, '');
	const spec = declaration(source);
	if (spec.id !== courseworkTemplate || spec.version !== version) return;
	const workflow = spec.checks?.find(item => item.id === 'workflow');
	if (!workflow || workflow.path !== courseworkScript || workflow.name !== '有效课程和截止日' ||
		Object.keys(workflow).some(key => !['id','name','path','linkEvidence'].includes(key))) return;
	if (workflow.linkEvidence === true) return raw;
	if (workflow.linkEvidence !== undefined) return;

	// Use the JSON value's source range to preserve the rest of the user's declaration.
	const doc = parseDocument(source, {schema:'json'});
	const checks = doc.get('checks', true);
	if (doc.errors.length || !isSeq(checks)) return;
	const node = checks.items.find(item => isMap(item) && item.get('id') === 'workflow');
	if (!isMap(node)) return;
	const pair = node.items.at(-1);
	if (!isScalar(pair?.key) || !pair.key.range || !isScalar(pair.value) || !pair.value.range) return;
	const indent = /(\r?\n[\t ]*)$/u.exec(source.slice(0,pair.key.range[0]))?.[1] ?? ' ';
	const end = pair.value.range[1];
	const updated = source.slice(0,end) + ',' + indent + '"linkEvidence": true' + source.slice(end);
	return declaration(updated).checks?.find(item => item.id === 'workflow')?.linkEvidence === true
		? raw.slice(0,raw.length - source.length) + updated : undefined;
}
