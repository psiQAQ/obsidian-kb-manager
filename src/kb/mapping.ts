import { fromEnglish } from '../i18n.ts';
import { parse } from 'smol-toml';
import { segments } from '../fs/segments.ts';

export interface Mapping {
	raw: string;
	wiki: string;
	reports: string;
	templates: string;
	index: string;
	log: string;
	overview: string;
	notes: string;
	clippings?: string;
}

export function readMapping(text: string): Mapping {
	const data = parse(text.replace(/^\uFEFF/u, ''));
	if (data.version !== 1) throw new Error(fromEnglish('kb.toml requires version = 1','kb.toml 的 version 必须为 1'));
	const fields = data.paths;
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(fromEnglish('Missing [paths]','缺少 [paths] 段'));
	const entries = Object.entries(fields);
	const allowed = ['raw', 'wiki', 'reports', 'templates', 'index', 'log', 'overview', 'clippings'];
	const values = new Map<string, string>();
	for (const [key, value] of entries) {
		if (!allowed.includes(key) || typeof value !== 'string') throw new Error(fromEnglish('Invalid paths.','无效的 paths.') + key);
		segments(value);
		values.set(key, value);
	}
	function required(key: string): string {
		const value = values.get(key);
		if (!value) throw new Error(fromEnglish('Missing paths.','缺少 paths.') + key);
		return value;
	}
	const mapping: Mapping = {
		raw: required('raw'), wiki: required('wiki'), reports: required('reports'),
		templates: required('templates'), index: required('index'), log: required('log'),
		overview: required('overview'), notes: 'Notes', clippings: values.get('clippings'),
	};
	const directories = [mapping.raw, mapping.wiki, mapping.reports, mapping.templates, mapping.notes];
	if (mapping.clippings) directories.push(mapping.clippings);
	const canonical = (name: string) => name.normalize('NFC').toLowerCase();
	for (const [index, name] of directories.entries()) {
		const key = canonical(name);
		if (directories.some((other, i) => i !== index && (canonical(other) + '/').startsWith(key + '/'))) {
			throw new Error(fromEnglish('Overlapping content directories: ','内容目录重叠：') + name);
		}
	}
	const pages = [mapping.index, mapping.log, mapping.overview];
	for (const page of pages) {
		if (!page.startsWith(mapping.wiki + '/') || !page.endsWith('.md')) {
			throw new Error(fromEnglish('Expected Markdown entry inside ','Markdown 入口应位于 ') + mapping.wiki + ': ' + page);
		}
	}
	if (new Set(pages.map(canonical)).size !== pages.length) throw new Error(fromEnglish('Duplicate wiki entry','wiki 入口重复'));
	return mapping;
}
