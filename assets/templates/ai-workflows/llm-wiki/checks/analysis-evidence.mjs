import { posix } from 'node:path';

const knowledgeTypes = new Set(['source', 'entity', 'concept', 'analysis', 'archive', 'overview', 'category']);

function removeCode(body) {
	let fence;
	const listIndents = [];
	const prose = [];
	for (const raw of body.split(/\r?\n/u)) {
		const indent = raw.match(/^[ \t]*/u)[0];
		let width = 0;
		for (const char of indent) width += char === '\t' ? 4 - width % 4 : 1;
		const line = ' '.repeat(width) + raw.slice(indent.length);
		if (!line.trim()) {
			prose.push('');
			continue;
		}
		while (listIndents.length && width < listIndents.at(-1)) listIndents.pop();
		const listIndent = listIndents.at(-1) ?? 0;
		if (fence) {
			if (width >= fence.indent) {
				const close = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line.slice(fence.indent));
				if (close?.[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) fence = undefined;
				continue;
			}
			fence = undefined;
		}
		const content = line.slice(listIndent);
		if (content.startsWith('    ')) continue;
		const item = /^ {0,3}(?:[-+*]|\d{1,9}[.)]) {1,4}(?=\S)/u.exec(content);
		if (item) listIndents.push(listIndent + item[0].length);
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(content.slice(item?.[0].length ?? 0));
		if (marker) {
			fence = { marker:marker[1], indent:listIndents.at(-1) ?? 0 };
			continue;
		}
		prose.push(content.replace(/(`+)[^\n]*?\1(?!`)/gu, ''));
	}
	return prose.join('\n');
}

function indexedPaths(index, libraryRoot) {
	const indexed = new Set();
	const definitions = new Map();
	const labelKey = label => label.trim().replace(/\s+/gu, ' ').toUpperCase().toLowerCase();
	const definition = /^ {0,3}\[([^[\]\n]+)\]:[ \t]*(<[^<>\n]*>|[^\s<>]+?)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*$/gmu;
	const prose = removeCode(index.body).replace(definition, (_, label, destination) => {
		const key = labelKey(label);
		if (!definitions.has(key)) definitions.set(key, destination);
		return '';
	});
	const links = /(?<!!)\[([^\n[\]]*)\](?:\((<[^>\n]+>|[^\n)]+)\)|\[([^\n[\]]*)\])|(?<!!)\[\[([^\n\]#|]+)(?:[^\n\]]*)\]\]/gu;
	for (const [, text, inline, reference, rawWiki] of prose.matchAll(links)) {
		const rawMarkdown = inline ?? (reference !== undefined ? definitions.get(labelKey(reference || text)) : undefined);
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
	const checkedItems = [];
	for (const { path, properties } of notes) {
		const { managed_by: managedBy, type, status, sources } = properties;
		if (!path.startsWith(wiki + '/') || path === indexPath || managedBy !== 'agent' || !knowledgeTypes.has(type)) continue;
		if (type === 'overview' && status === 'empty') continue;
		if (indexed) {
			const covered = indexed.has(path);
			checkedItems.push({file:path, subject:'本库索引中指向此 Agent 管理知识页的链接',
				outcome:covered ? '索引中有指向此页的链接。' : '索引中缺少指向此页的链接。'});
			if (!covered) findings.push({severity:'warning', code:'knowledge-index-uncovered', file:path, message:'本库索引没有指向这篇 Agent 管理知识页的链接：' + indexPath});
		}
		if (type === 'analysis') {
			const declared = [sources].flat().some(source => typeof source === 'string' && source.trim());
			const message = '分析页未声明 sources，请人工核对分析依据及来源。';
			checkedItems.push({file:path, subject:'分析页的 sources 属性', outcome:declared ? '已填写来源文本。' : message});
			if (!declared) findings.push({severity:'warning', code:'analysis-evidence-missing', file:path, message});
		}
	}
	return {findings, checkedItems};
}
