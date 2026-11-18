import { parse } from 'smol-toml';
import { segments } from '../fs/paths.ts';

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
	if (data.version !== 1) throw new Error('kb.toml requires version = 1');
	const fields = data.paths;
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Missing [paths]');
	const entries = Object.entries(fields);
	const allowed = ['raw', 'wiki', 'reports', 'templates', 'index', 'log', 'overview', 'clippings'];
	const values = new Map<string, string>();
	for (const [key, value] of entries) {
		if (!allowed.includes(key) || typeof value !== 'string') throw new Error('Invalid paths.' + key);
		segments(value);
		values.set(key, value);
	}
	function required(key: string): string {
		const value = values.get(key);
		if (!value) throw new Error('Missing paths.' + key);
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
			throw new Error('Overlapping content directories: ' + name);
		}
	}
	const pages = [mapping.index, mapping.log, mapping.overview];
	for (const page of pages) {
		if (!page.startsWith(mapping.wiki + '/') || !page.endsWith('.md')) {
			throw new Error('Expected Markdown entry inside ' + mapping.wiki + ': ' + page);
		}
	}
	if (new Set(pages.map(canonical)).size !== pages.length) throw new Error('Duplicate wiki entry');
	return mapping;
}
