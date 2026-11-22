export default async function check({ libraryRoot, notes }) {
	const sources = new Set(notes.filter(note => note.path.startsWith('Sources/') && note.properties.type === 'evidence-source').map(note => note.path.replace(/\.md$/u, '')));
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Evidence/') || properties.type !== 'evidence-claim') return [];
		const declared = [properties.sources].flat().filter(value => value != null && (typeof value !== 'string' || value.trim()));
		if (!declared.length) return [{ severity:'warning', code:'evidence-source-missing', file:path, message:'请给证据页添加可定位的来源。' }];
		return declared.flatMap(value => {
			const target = typeof value === 'string' ? value.match(/^\[\[([^#|\]]+)/u)?.[1] : undefined;
			const relative = target?.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target;
			if (relative && sources.has(relative.replace(/\.md$/u, ''))) return [];
			return [{ severity:'warning', code:'evidence-source-invalid', file:path, message:'证据来源应指向本库 Sources 下的来源页：' + String(value) }];
		});
	});
}
