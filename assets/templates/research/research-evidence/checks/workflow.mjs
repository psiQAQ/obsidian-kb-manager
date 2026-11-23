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
	const sources = new Set(notes.filter(note => note.path.startsWith('Sources/') && note.properties.type === 'evidence-source')
		.map(note => note.path.replace(/\.md$/u, '')));
	let unverified = 0;
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (!path.startsWith('Evidence/') || properties.type !== 'evidence-claim') continue;
		const subject = '证据页的 sources 来源';
		const declared = [properties.sources].flat().filter(value => value != null && (typeof value !== 'string' || value.trim()));
		if (!declared.length) {
			const message = '请给证据页添加可定位的来源。';
			checkedItems.push({file:path, subject, outcome:message});
			findings.push({severity:'warning', code:'evidence-source-missing', file:path, message});
			continue;
		}
		let valid = 0, invalid = 0;
		for (const value of declared) {
			const target = localTarget(value, path, context);
			if (sources.has(target)) {
				valid++;
			} else if (target === null) {
				unverified++;
				findings.push({severity:'info', code:'evidence-source-unverified', file:path, message:'请在 Obsidian 中核实 sources 指向的来源页。'});
			} else {
				invalid++;
				findings.push({severity:'warning', code:'evidence-source-invalid', file:path, message:'证据来源应指向本库 Sources 下的来源页：' + String(value)});
			}
		}
		if (valid + invalid) checkedItems.push({file:path, subject, count:valid + invalid,
			outcome:`指向本库 Sources 来源页 ${valid} 条，目标不符合要求 ${invalid} 条。`});
	}
	return {findings, unverified, checkedItems};
}
