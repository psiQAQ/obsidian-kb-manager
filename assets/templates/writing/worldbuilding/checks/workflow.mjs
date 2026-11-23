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

function gregorianDate(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
	const date = new Date(value + 'T00:00:00Z');
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export default async function check(context) {
	const { notes } = context;
	const places = new Set(notes.filter(note => note.path.startsWith('Places/') && note.properties.type === 'world-place').map(note => note.path.replace(/\.md$/u, '')));
	let unverified = 0;
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (!path.startsWith('Events/') || properties.type !== 'world-event') continue;
		const { start, end, location } = properties;
		const startValid = gregorianDate(start);
		const endValid = gregorianDate(end);
		for (const [field, value, valid] of [['start', start, startValid], ['end', end, endValid]]) {
			if (valid === undefined) continue;
			const message = `${field} 填写为 ${value}，该日期在公历中不存在。`;
			checkedItems.push({file:path, subject:`事件的 ${field} 公历日期`, outcome:valid ? '日期有效：' + value : message});
			if (!valid) findings.push({severity:'warning', code:'event-date-invalid', file:path, message});
		}
		if (startValid && endValid) {
			const message = '事件结束日期早于开始日期。';
			checkedItems.push({file:path, subject:'事件的 start 与 end 先后顺序', outcome:end < start ? message : `${start} 至 ${end}，顺序符合规则。`});
			if (end < start) findings.push({severity:'warning', code:'event-date-order', file:path, message});
		}
		if (location) {
			const subject = '事件的 location 地点链接';
			const place = localTarget(location, path, context);
			if (place === null) {
				unverified++;
				findings.push({severity:'info', code:'event-location-unverified', file:path, message:'请在 Obsidian 中核实 location 指向的地点。'});
			} else if (!places.has(place)) {
				const message = '事件的 location 应指向本库 Places 下的地点页。';
				checkedItems.push({file:path, subject, outcome:message});
				findings.push({severity:'warning', code:'event-location-invalid', file:path, message});
			} else {
				checkedItems.push({file:path, subject, outcome:'链接指向本库 Places 中的地点页。'});
			}
		}
	}
	return {findings, unverified, checkedItems};
}
