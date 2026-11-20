import { posix } from 'node:path';

const knowledgeTypes = new Set(['source', 'entity', 'concept', 'analysis', 'archive', 'overview', 'category']);

function removeCode(body) {
	let fence;
	const prose = [];
	for (const line of body.split(/\r?\n/u)) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence) {
			if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
			continue;
		}
		if (marker) {
			fence = marker[1];
			continue;
		}
		if (!/^(?: {4}|\t)/u.test(line)) prose.push(line.replace(/(`+)[^\n]*?\1(?!`)/gu, ''));
	}
	return prose.join('\n');
}

function indexedPaths(index, libraryRoot) {
	const indexed = new Set();
	const prose = removeCode(index.body);
	for (const [, rawMarkdown, rawWiki] of prose.matchAll(/(?<!!)\[[^\n\]]*\]\((<[^>\n]+>|[^\n)]+)\)|(?<!!)\[\[([^\n\]#|]+)(?:[^\n\]]*)\]\]/gu)) {
		if (rawMarkdown) {
			const link = rawMarkdown.replace(/^<|>$/gu, '').split('#', 1)[0];
			if (!/^\.{1,2}\//u.test(link)) continue;
			try {
				indexed.add(posix.normalize(posix.join(posix.dirname(index.path), decodeURIComponent(link))));
			} catch {
				// The general link check reports malformed links.
			}
		} else if (rawWiki?.includes('/')) {
			const path = libraryRoot && rawWiki.startsWith(libraryRoot + '/') ? rawWiki.slice(libraryRoot.length + 1) : rawWiki;
			indexed.add(path.endsWith('.md') ? path : path + '.md');
		}
	}
	return indexed;
}

export default async function check({ manifest, libraryRoot, notes }) {
	const wiki = manifest?.paths?.wiki ?? 'wiki';
	const indexPath = manifest?.paths?.index ?? wiki + '/index.md';
	const index = notes.find(note => note.path === indexPath);
	const indexed = index && indexedPaths(index, libraryRoot);
	const findings = [];
	for (const { path, properties } of notes) {
		const { managed_by: managedBy, type, status, sources } = properties;
		if (!path.startsWith(wiki + '/') || path === indexPath || managedBy !== 'agent' || !knowledgeTypes.has(type)) continue;
		if (type === 'overview' && status === 'empty') continue;
		if (indexed && !indexed.has(path)) findings.push({ severity:'warning', code:'knowledge-index-uncovered', file:path, message:'本库索引没有指向这篇 Agent 管理知识页的链接：' + indexPath });
		if (type === 'analysis' && ![sources].flat().some(source => typeof source === 'string' && source.trim())) {
			findings.push({ severity:'warning', code:'analysis-evidence-missing', file:path, message:'分析页未声明 sources，请人工核对分析依据及来源。' });
		}
	}
	return findings;
}
