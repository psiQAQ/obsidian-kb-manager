export default async function check({ libraryRoot, notes }) {
	const literature = new Set(notes.filter(note => note.path.startsWith('Literature/') && note.properties.type === 'literature-card').map(note => note.path.replace(/\.md$/u, '')));
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Permanent/') || properties.type !== 'permanent-card' || properties.origin !== 'literature') return [];
		const linked = [properties.literature].flat().some(value => {
			const target = typeof value === 'string' ? value.match(/^\[\[([^#|\]]+)/u)?.[1] : undefined;
			const relative = target?.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target;
			return relative && literature.has(relative.replace(/\.md$/u, ''));
		});
		return linked ? [] : [{ severity:'warning', code:'literature-card-missing', file:path, message:'文献提炼卡应保留一条本库文献卡链接。' }];
	});
}
