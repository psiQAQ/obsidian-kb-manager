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
	const findings = notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Evidence/') || properties.type !== 'evidence-claim') return [];
		const declared = [properties.sources].flat().filter(value => value != null && (typeof value !== 'string' || value.trim()));
		if (!declared.length) return [{ severity:'warning', code:'evidence-source-missing', file:path, message:'请给证据页添加可定位的来源。' }];
		return declared.flatMap(value => {
			const target = localTarget(value, path, context);
			if (sources.has(target)) return [];
			if (target === null) {
				unverified++;
				return [{ severity:'info', code:'evidence-source-unverified', file:path, message:'请在 Obsidian 中核实 sources 指向的来源页。' }];
			}
			return [{ severity:'warning', code:'evidence-source-invalid', file:path, message:'证据来源应指向本库 Sources 下的来源页：' + String(value) }];
		});
	});
	return { findings, unverified };
}
