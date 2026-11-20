export default async function check({ libraryRoot, notes }) {
	const decisions = new Map(notes.filter(note => note.path.startsWith('Decisions/') && note.properties.type === 'ai-decision').map(note => [note.path, note.properties]));
	const graph = new Map();
	const findings = [];
	for (const [file, { supersedes }] of decisions) {
		if (!supersedes) continue;
		const link = typeof supersedes === 'string' && supersedes.match(/^\[\[([^#|\]]+)/u)?.[1];
		const relative = link && link.startsWith(libraryRoot + '/') ? link.slice(libraryRoot.length + 1) : link;
		const target = relative && (relative.endsWith('.md') ? relative : relative + '.md');
		if (!target || !decisions.has(target)) findings.push({ severity:'warning', code:'superseded-decision-missing', file, message:'supersedes 应指向本库的旧决定。' });
		else graph.set(file, target);
	}
	const visited = new Set();
	for (const file of graph.keys()) {
		const walk = new Set();
		let target = file;
		while (target && !visited.has(target) && !walk.has(target)) {
			walk.add(target);
			target = graph.get(target);
		}
		if (walk.has(target)) findings.push({ severity:'warning', code:'decision-cycle', file:target, message:'决定的取代关系形成循环，请核对先后。' });
		for (const step of walk) visited.add(step);
	}
	return findings;
}
