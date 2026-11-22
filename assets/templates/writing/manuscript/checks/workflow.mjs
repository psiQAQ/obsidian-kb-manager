function localTarget(value, file, { libraryRoot, links }) {
	const raw = typeof value === 'string' && value.match(/^\[\[([^|\]\n]+)(?:\|[^\]\n]*)?\]\]$/u)?.[1].replace(/\\$/u, '').trim();
	const target = raw && raw.split('#', 1)[0].trim();
	if (!target) return undefined;
	const reference = links?.[file]?.references.find(item => item.line === undefined && item.target?.trim() === raw);
	if (reference?.status === 'missing') return undefined;
	const located = reference?.status === 'resolved' ? reference.path : target;
	if (libraryRoot && located?.startsWith(libraryRoot + '/')) return located.slice(libraryRoot.length + 1).replace(/\.md$/u, '');
	if (reference?.status === 'resolved') return libraryRoot ? undefined : located?.replace(/\.md$/u, '');
	if (!links && target.includes('/')) return target.replace(/\.md$/u, '');
	return null;
}

export default async function check(context) {
	const { notes } = context;
	const manuscripts = new Set(notes.filter(note => note.path.startsWith('Manuscript/') && note.properties.type === 'manuscript')
		.map(note => note.path.replace(/\.md$/u, '')));
	const assigned = new Map();
	const findings = [];
	let unverified = 0;
	for (const { path, properties } of notes) {
		const { type, manuscript, chapter } = properties;
		if (!path.startsWith('Manuscript/Chapters/') || type !== 'chapter') continue;
		const numbered = chapter !== '' && chapter != null;
		if (numbered && (!Number.isInteger(chapter) || chapter < 1)) {
			findings.push({ severity:'warning', code:'chapter-order-invalid', file:path, message:'章节序号 chapter 应为正整数。' });
		}
		if (!numbered && !manuscript) continue;
		const target = localTarget(manuscript, path, context);
		if (target === null) {
			unverified++;
			findings.push({ severity:'info', code:'chapter-manuscript-unverified', file:path, message:'请在 Obsidian 中核实 manuscript 指向的书稿。' });
			continue;
		}
		if (!manuscripts.has(target)) {
			findings.push({ severity:'warning', code:'chapter-manuscript-invalid', file:path, message:'manuscript 应指向本库的书稿页。' });
			continue;
		}
		if (!Number.isInteger(chapter) || chapter < 1) continue;
		const key = JSON.stringify([target, chapter]);
		const previous = assigned.get(key);
		if (previous) findings.push({ severity:'warning', code:'chapter-order-duplicate', file:path, message:'该书稿中另有同序号章节：' + previous });
		else assigned.set(key, path);
	}
	return { findings, unverified };
}
