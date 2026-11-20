export default async function check({ libraryRoot, notes }) {
	const places = new Set(notes.filter(note => note.path.startsWith('Places/') && note.properties.type === 'world-place').map(note => note.path.replace(/\.md$/u, '')));
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Events/') || properties.type !== 'world-event') return [];
		const { start, end, location } = properties;
		const findings = [];
		if (typeof start === 'string' && typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(start) && /^\d{4}-\d{2}-\d{2}$/u.test(end) && end < start) {
			findings.push({ severity:'warning', code:'event-date-order', file:path, message:'事件结束日期早于开始日期。' });
		}
		if (location) {
			const target = typeof location === 'string' && location.match(/^\[\[([^#|\]]+)/u)?.[1];
			const relative = target && target.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target;
			if (!relative || !places.has(relative.replace(/\.md$/u, ''))) findings.push({ severity:'warning', code:'event-location-invalid', file:path, message:'事件的 location 应指向本库 Places 下的地点页。' });
		}
		return findings;
	});
}
