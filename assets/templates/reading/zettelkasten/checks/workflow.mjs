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
	const literature = new Set(notes.filter(note => note.path.startsWith('Literature/') && note.properties.type === 'literature-card').map(note => note.path.replace(/\.md$/u, '')));
	let unverified = 0;
	const findings = notes.flatMap(({ path, properties }) => {
		if (!(path.startsWith('Permanent/') && properties.type === 'permanent-card' && properties.origin === 'literature')) return [];
		const targets = [properties.literature].flat().map(value => localTarget(value, path, context));
		if (targets.some(target => literature.has(target))) return [];
		if (targets.includes(null)) {
			unverified++;
			return [{ severity:'info', code:'literature-card-unverified', file:path, message:'请在 Obsidian 中核实 literature 指向的文献卡。' }];
		}
		return [{ severity:'warning', code:'literature-card-missing', file:path, message:'文献提炼卡应保留一条本库文献卡链接。' }];
	});
	return { findings, unverified };
}
