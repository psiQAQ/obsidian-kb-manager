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
	const courses = new Set(notes.filter(note => note.path.startsWith('Courses/') && note.properties.type === 'course').map(note => note.path.replace(/\.md$/u, '')));
	let unverified = 0;
	const findings = notes.flatMap(({ path, properties }) => {
		if (properties.type !== 'assignment' || properties.status !== 'scheduled' || !path.startsWith('Courses/')) return [];
		const course = localTarget(properties.course, path, context);
		const due = properties.due;
		const date = typeof due === 'string' ? new Date(due + 'T00:00:00Z') : new Date(NaN);
		const dueOk = !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === due;
		if (course === null) {
			unverified++;
			if (dueOk) return [{ severity:'info', code:'assignment-course-unverified', file:path, message:'请在 Obsidian 中核实 course 指向的课程。' }];
		} else if (courses.has(course) && dueOk) return [];
		return [{ severity:'warning', code:'assignment-schedule-invalid', file:path, message:course === null
			? '已排期的作业需要有效的 YYYY-MM-DD 截止日。课程链接尚待核实。'
			: '已排期的作业需要本库课程链接和有效的 YYYY-MM-DD 截止日。' }];
	});
	return { findings, unverified };
}
