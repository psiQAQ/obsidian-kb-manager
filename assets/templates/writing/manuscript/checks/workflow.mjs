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
	const checkedItems = [];
	let unverified = 0;
	for (const { path, properties } of notes) {
		const { type, manuscript, chapter } = properties;
		if (!path.startsWith('Manuscript/Chapters/') || type !== 'chapter') continue;
		const numbered = chapter !== '' && chapter != null;
		const orderValid = Number.isInteger(chapter) && chapter >= 1;
		if (numbered) {
			const message = '章节序号 chapter 应为正整数。';
			checkedItems.push({file:path, subject:'章节的 chapter 序号', outcome:orderValid ? '正整数序号：' + chapter : message});
			if (!orderValid) findings.push({severity:'warning', code:'chapter-order-invalid', file:path, message});
		}
		if (!numbered && !manuscript) continue;
		const subject = '章节的 manuscript 书稿链接';
		const target = localTarget(manuscript, path, context);
		if (target === null) {
			unverified++;
			findings.push({ severity:'info', code:'chapter-manuscript-unverified', file:path, message:'请在 Obsidian 中核实 manuscript 指向的书稿。' });
			continue;
		}
		if (!manuscripts.has(target)) {
			const message = 'manuscript 应指向本库的书稿页。';
			checkedItems.push({file:path, subject, outcome:message});
			findings.push({severity:'warning', code:'chapter-manuscript-invalid', file:path, message});
			continue;
		}
		checkedItems.push({file:path, subject, outcome:'链接指向本库书稿页。'});
		if (!orderValid) continue;
		const key = JSON.stringify([target, chapter]);
		const siblings = assigned.get(key);
		if (siblings) {
			findings.push({severity:'warning', code:'chapter-order-duplicate', file:path, message:'该书稿中另有同序号章节：' + siblings[0]});
			siblings.push(path);
		} else assigned.set(key, [path]);
	}
	for (const siblings of assigned.values()) {
		const outcome = siblings.length === 1 ? '在已解析到同一书稿的章节中，序号唯一。' : `在已解析到同一书稿的章节中，有 ${siblings.length} 章使用该序号。`;
		for (const file of siblings) checkedItems.push({file, subject:'同一书稿内的章节序号重复情况', outcome});
	}
	return {findings, unverified, checkedItems};
}
