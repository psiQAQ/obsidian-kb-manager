export default async function check({ libraryRoot, notes }) {
	const categories = new Set(notes.filter(note => note.path.startsWith('Categories/')).map(note => note.path));
	return notes.flatMap(({ path, properties }) => {
		if (path.startsWith('Templates/')) return [];
		return [properties.categories].flat().flatMap(value => {
			const target = typeof value === 'string' && value.match(/^\[\[([^#|\]]+)/u)?.[1];
			if (!target || !target.split('/').includes('Categories')) return [];
			const relative = target.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target;
			const file = relative.endsWith('.md') ? relative : relative + '.md';
			if (categories.has(file)) return [];
			return [{ severity:'warning', code:'category-link-outside-library', file:path, message:'分类链接未指向本库的分类页：' + value }];
		});
	});
}
