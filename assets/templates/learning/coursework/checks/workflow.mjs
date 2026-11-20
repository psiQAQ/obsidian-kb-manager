export default async function check({ libraryRoot, notes }) {
	const courses = new Set(notes.filter(note => note.path.startsWith('Courses/') && note.properties.type === 'course').map(note => note.path.replace(/\.md$/u, '')));
	return notes.flatMap(({ path, properties }) => {
		if (properties.type !== 'assignment' || properties.status !== 'scheduled' || !path.startsWith('Courses/')) return [];
		const target = typeof properties.course === 'string' && properties.course.match(/^\[\[([^#|\]]+)/u)?.[1];
		const course = target && target.startsWith(libraryRoot + '/') ? target.slice(libraryRoot.length + 1) : target;
		const due = properties.due;
		const date = typeof due === 'string' ? new Date(due + 'T00:00:00Z') : new Date(NaN);
		const dueOk = !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === due;
		if (course && courses.has(course.replace(/\.md$/u, '')) && dueOk) return [];
		return [{ severity:'warning', code:'assignment-schedule-invalid', file:path, message:'已排期的作业需要本库课程链接和有效的 YYYY-MM-DD 截止日。' }];
	});
}
