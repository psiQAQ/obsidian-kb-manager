export default async function check({ libraryRoot, notes }) {
	const privateNotes = new Set(notes.filter(note => note.properties.visibility === 'private').map(note => note.path.replace(/\.md$/u, '')));
	return notes.flatMap(({ path, body, properties }) => {
		if (properties.type !== 'garden-note' || properties.publish_ready !== true) return [];
		const text = [body, ...[properties.related].flat()].filter(value => typeof value === 'string').join('\n');
		const seen = new Set();
		return Array.from(text.matchAll(/\[\[([^#|\]]+)/gu), ([, target]) => {
			const relative = target.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target;
			return relative.replace(/\.md$/u, '');
		}).flatMap(target => {
			if (!privateNotes.has(target) || seen.has(target)) return [];
			seen.add(target);
			return [{ severity:'warning', code:'sharing-private-reference', file:path, message:'拟分享页面引用私有页面：' + target }];
		});
	});
}
