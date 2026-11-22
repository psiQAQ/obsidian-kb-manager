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
	const places = new Set(notes.filter(note => note.path.startsWith('Places/') && note.properties.type === 'world-place').map(note => note.path.replace(/\.md$/u, '')));
	let unverified = 0;
	const findings = notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Events/') || properties.type !== 'world-event') return [];
		const { start, end, location } = properties;
		const findings = [];
		if (typeof start === 'string' && typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(start) && /^\d{4}-\d{2}-\d{2}$/u.test(end) && end < start) {
			findings.push({ severity:'warning', code:'event-date-order', file:path, message:'事件结束日期早于开始日期。' });
		}
		if (location) {
			const place = localTarget(location, path, context);
			if (place === null) {
				unverified++;
				findings.push({ severity:'info', code:'event-location-unverified', file:path, message:'请在 Obsidian 中核实 location 指向的地点。' });
			} else if (!places.has(place)) {
				findings.push({ severity:'warning', code:'event-location-invalid', file:path, message:'事件的 location 应指向本库 Places 下的地点页。' });
			}
		}
		return findings;
	});
	return { findings, unverified };
}
