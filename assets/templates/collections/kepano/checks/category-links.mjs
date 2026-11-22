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
	const findings = notes.flatMap(({ path, properties }) => {
		if (path.startsWith('Templates/')) return [];
		return [properties.categories].flat().filter(value => value != null && value !== '').flatMap(value => {
			const target = localTarget(value, path, context);
			if (categories.has(target)) return [];
			if (target === null) {
				unverified++;
				return [{ severity:'info', code:'category-link-unverified', file:path, message:'请在 Obsidian 中核实 categories 指向的分类页。' }];
			}
			return [{ severity:'warning', code:'category-link-outside-library', file:path, message:'分类链接未指向本库的分类页：' + String(value) }];
		});
	});
	return { findings, unverified };
}
