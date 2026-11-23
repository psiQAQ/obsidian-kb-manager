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
	const categories = new Set(notes.filter(note => note.path.startsWith('Categories/') || note.path === 'References/Apps.md')
		.map(note => note.path.replace(/\.md$/u, '')));
	let unverified = 0;
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (path.startsWith('Templates/')) continue;
		let valid = 0, invalid = 0;
		for (const value of [properties.categories].flat().filter(value => value != null && value !== '')) {
			const target = localTarget(value, path, context);
			if (categories.has(target)) {
				valid++;
			} else if (target === null) {
				unverified++;
				findings.push({severity:'info', code:'category-link-unverified', file:path, message:'请在 Obsidian 中核实 categories 指向的分类页。'});
			} else {
				invalid++;
				findings.push({severity:'warning', code:'category-link-outside-library', file:path, message:'分类链接未指向本库的分类页：' + String(value)});
			}
		}
		if (valid + invalid) checkedItems.push({file:path, subject:'categories 分类链接', count:valid + invalid,
			outcome:`指向本库分类页 ${valid} 条，未指向本库分类页 ${invalid} 条。`});
	}
	return {findings, unverified, checkedItems};
}
