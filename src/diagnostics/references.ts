import {tr} from '../i18n.ts';
import {wikiPattern} from '../kb/audit-markdown.ts';
import type {Diagnostic, DiagnosticCheckResult, LinkRequest, LinkResolution} from './types.ts';

const label = String.raw`([^\[\]\s\\]+)`;
const definition = new RegExp(String.raw`^ {0,3}\[\^${label}\]:`, 'u');
const possibleDefinition = new RegExp(String.raw`^\s*(?:(?:[-+*]|\d+[.)])\s+)?\[\^${label}\]:`, 'u');
const reference = new RegExp(String.raw`\[\^${label}\](?![[(\]])`, 'gu');
const inline = /\^\[(?:\\.|[^[\]\\])+\]/gu;
const escaped = (prefix: string) => /(?:^|[^\\])(?:\\\\)*\\$/u.test(prefix);
const normalize = (name: string) => name.toUpperCase().toLowerCase();

/** The caller supplies Markdown prose with literals and formulas masked and line breaks preserved. */
export function inspectFootnotes(check: DiagnosticCheckResult, body: string, file: string, lineOffset: number) {
	const defined = new Set<string>(), uncertain = new Set<string>();
	const refs: {label: string; line: number}[] = [];
	for (const [index, raw] of body.split('\n').entries()) {
		const line = raw.replace(/^(?: {0,3}>[ \t]?)+/u, '');
		const marker = definition.exec(line);
		if (marker) defined.add(normalize(marker[1]!));
		else {
			const ambiguous = possibleDefinition.exec(line);
			if (ambiguous) {uncertain.add(normalize(ambiguous[1]!)); continue;}
			if (/^(?: {4}|\t)/u.test(line)) continue;
		}
		const content = line.slice(marker?.[0].length ?? 0).replace(wikiPattern, '');
		const normal = content.replace(inline, (text: string, offset: number) => {
			if (escaped(content.slice(0, offset))) return text;
			check.coverage.checked++;
			return '';
		});
		for (const match of normal.matchAll(reference)) {
			if (escaped(normal.slice(0, match.index)) || match[1]!.includes('{{')) continue;
			refs.push({label:match[1]!, line:lineOffset + index + 1});
		}
	}
	for (const ref of refs) {
		const name = normalize(ref.label);
		if (!defined.has(name) && uncertain.has(name)) {check.coverage.unknown++; continue;}
		check.coverage.checked++;
		if (!defined.has(name)) check.diagnostics.push({severity:'error',code:'missing-footnote-definition',file,line:ref.line,evidence:ref.label,
			message:tr('本笔记缺少对应的脚注定义。请补充定义或更新引用。','This note is missing the footnote definition. Add the definition or update the reference.')});
	}
}

export function inspectPdfFragment(check: DiagnosticCheckResult, link: LinkRequest, found: LinkResolution,
	position: Pick<Diagnostic,'file'|'line'|'evidence'>) {
	if (!link.fragment || !/\.pdf$/iu.test(found.path ?? link.target)) return false;
	const parts = link.fragment.slice(1).split('&');
	const pages = parts.filter(part => /^page(?:=|$)/iu.test(part)).map(part => part.slice(5));
	const hasLocation = parts.some(part => /^(?:selection|annotation)(?:=|$)/iu.test(part));
	if (hasLocation && found.status !== 'missing') {
		check.coverage.unknown++;
		check.diagnostics.push({...position,severity:'info',code:'unverified-pdf-location',
			message:tr('请打开 PDF 核对引用的选区或批注。','Open the PDF to verify the referenced selection or annotation.')});
	}
	if (!pages.length) {
		if (!hasLocation || found.status === 'missing') check.coverage.skipped++;
	}
	else if (pages.some(page => !/^\d+$/u.test(page) || !/[1-9]/u.test(page))) {
		check.coverage.checked++;
		check.diagnostics.push({...position,severity:'error',code:'invalid-pdf-page',
			message:tr('PDF 的 page 参数须为正整数，例如 #page=3。','Use a positive integer for the PDF page parameter, for example #page=3.')});
	} else if (found.status === 'missing') check.coverage.skipped++;
	else {
		check.coverage.unknown++;
		check.diagnostics.push({...position,severity:'info',code:'unverified-pdf-page',
			message:tr('未能确认 PDF 的总页数。请打开附件核对页码。','Could not verify the PDF page count. Open the attachment to check the page number.')});
	}
	return true;
}
