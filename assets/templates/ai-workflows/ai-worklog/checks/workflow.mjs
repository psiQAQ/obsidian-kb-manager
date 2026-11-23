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
	const decisions = new Map(notes.filter(note => note.path.startsWith('Decisions/') && note.properties.type === 'ai-decision').map(note => [note.path, note.properties]));
	const graph = new Map();
	const findings = [];
	const checkedItems = [];
	let unverified = 0;
	for (const [file, { supersedes }] of decisions) {
		if (!supersedes) continue;
		const subject = '决定的 supersedes 取代链接';
		const relative = localTarget(supersedes, file, context);
		if (relative === null) {
			unverified++;
			findings.push({ severity:'info', code:'superseded-decision-unverified', file, message:'请在 Obsidian 中核实 supersedes 指向的旧决定。' });
		} else if (!relative || !decisions.has(relative + '.md')) {
			const message = 'supersedes 应指向本库的旧决定。';
			checkedItems.push({file, subject, outcome:message});
			findings.push({severity:'warning', code:'superseded-decision-missing', file, message});
		} else {
			checkedItems.push({file, subject, outcome:'链接指向本库决定。'});
			graph.set(file, relative + '.md');
		}
	}
	const visited = new Set();
	let cycles = 0;
	for (const file of graph.keys()) {
		const walk = new Set();
		let target = file;
		while (target && !visited.has(target) && !walk.has(target)) {
			walk.add(target);
			target = graph.get(target);
		}
		if (walk.has(target)) {
			cycles++;
			findings.push({severity:'warning', code:'decision-cycle', file:target, message:'决定的取代关系形成循环，请核对先后。'});
		}
		for (const step of walk) visited.add(step);
	}
	if (graph.size) checkedItems.push({file:'kb-template.json', subject:'库内取代关系的循环检查',
		outcome:`遍历 ${graph.size} 条已解析的取代关系，发现 ${cycles} 个循环。`});
	return {findings, unverified, checkedItems};
}
