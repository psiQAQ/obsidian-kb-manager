export default async function check({ libraryRoot, notes }) {
	const assigned = new Map();
	const findings = [];
	for (const { path, properties } of notes) {
		const { type, manuscript, chapter } = properties;
		if (!path.startsWith('Manuscript/Chapters/') || type !== 'chapter' || chapter === '' || chapter == null) continue;
		const target = typeof manuscript === 'string' && manuscript.match(/^\[\[([^#|\]]+)/u)?.[1];
		if (!target || !Number.isInteger(chapter) || chapter < 1) {
			findings.push({ severity:'warning', code:'chapter-order-invalid', file:path, message:'已指定序号的章节需要书稿链接和正整数 chapter。' });
			continue;
		}
		const relative = (target.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target).replace(/\.md$/u, '');
		const key = JSON.stringify([relative, chapter]);
		const previous = assigned.get(key);
		if (previous) findings.push({ severity:'warning', code:'chapter-order-duplicate', file:path, message:'该书稿中另有同序号章节：' + previous });
		else assigned.set(key, path);
	}
	return findings;
}
