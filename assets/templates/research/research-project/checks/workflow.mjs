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
	const evidence = new Set(notes.filter(note => note.properties.type === 'research-record' && note.path.startsWith('Records/')).map(note => note.path.replace(/\.md$/u, '')));
	let unverified = 0;
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (!(path.startsWith('Projects/') && properties.type === 'research-project' && properties.status === 'completed')) continue;
		const subject = '已结项课题的 evidence 研究记录';
		const targets = [properties.evidence].flat().map(value => localTarget(value, path, context));
		if (targets.some(target => evidence.has(target))) {
			checkedItems.push({file:path, subject, outcome:'至少一条链接指向本库 Records 中的研究记录。'});
		} else if (targets.includes(null)) {
			unverified++;
			findings.push({severity:'info', code:'research-evidence-unverified', file:path, message:'请在 Obsidian 中核实 evidence 指向的研究记录。'});
		} else {
			const message = '已结项的课题需要关联本库 Records 中的研究记录。';
			checkedItems.push({file:path, subject, outcome:message});
			findings.push({severity:'warning', code:'research-evidence-missing', file:path, message});
		}
	}
	return {findings, unverified, checkedItems};
}
