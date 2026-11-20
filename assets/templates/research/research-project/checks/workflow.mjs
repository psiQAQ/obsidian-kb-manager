export default async function check({ libraryRoot, notes }) {
	const evidence = new Set(notes.filter(note => note.properties.type === 'research-record' && note.path.startsWith('Records/')).map(note => note.path.replace(/\.md$/u, '')));
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Projects/') || properties.type !== 'research-project' || properties.status !== 'completed') return [];
		const linked = [properties.evidence].flat().some(value => {
			const target = typeof value === 'string' && value.match(/^\[\[([^#|\]]+)/u)?.[1];
			if (!target) return false;
			const relative = target.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target;
			return evidence.has(relative.replace(/\.md$/u, ''));
		});
		return linked ? [] : [{ severity:'warning', code:'research-evidence-missing', file:path, message:'已结项的课题需要关联本库 Records 中的研究记录。' }];
	});
}
