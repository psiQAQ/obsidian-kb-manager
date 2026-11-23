function checkCourse(value, references, libraryRoot, notes) {
	if (value == null || (typeof value === 'string' && !value.trim()))
		return ['assignment-course-missing', '已排期的作业缺少 course 链接。'];
	const target = typeof value === 'string' && /^\[\[([^|\]\n]+)(?:\|[^\]\n]*)?\]\]$/u.exec(value.trim())?.[1].replace(/\\$/u, '').trim();
	if (!target || !target.split('#', 1)[0].trim())
		return ['assignment-course-invalid', 'course 应填写指向本库课程笔记的 Wiki 链接。'];
	const unknown = ['assignment-course-unverified', '当前无法确认 course 指向的课程，请在 Obsidian 中核实链接和目标笔记。'];
	const reference = references?.find(item => item.line === undefined && item.target?.trim() === target);
	if (reference?.status === 'missing')
		return ['assignment-course-missing', '找不到 course 链接指向的笔记。'];
	if (reference?.status !== 'resolved' || !reference.path) return unknown;
	const prefix = libraryRoot ? libraryRoot + '/' : '';
	const path = reference.path.startsWith(prefix) ? reference.path.slice(prefix.length) : '';
	if (!path.startsWith('Courses/') || !/\.md$/iu.test(path))
		return ['assignment-course-invalid', 'course 链接须指向本库 Courses 目录中的课程笔记。'];
	const properties = notes.get(path);
	if (!properties) return unknown;
	if (properties.type !== 'course')
		return ['assignment-course-invalid', 'course 链接指向的笔记缺少 type: course。'];
	return reference.path;
}

function validDate(value) {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
	const date = new Date(value + 'T00:00:00Z');
	return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0,10) === value;
}

export default function check({ libraryRoot, notes, links }) {
	const byPath = new Map(notes.map(note => [note.path, note.properties]));
	const findings = [];
	const checkedItems = [];
	let unverified = 0;
	for (const {path, properties} of notes) {
		if (properties.type !== 'assignment' || properties.status !== 'scheduled' || !path.startsWith('Courses/')) continue;
		const course = checkCourse(properties.course, links?.[path]?.references, libraryRoot, byPath);
		const courseSubject = '已排期作业的 course 链接';
		if (typeof course === 'string') {
			const outcome = '链接指向本库课程：' + course;
			checkedItems.push({file:path, subject:courseSubject, outcome:outcome.length > 512 ? outcome.slice(0,511) + '…' : outcome});
		} else {
			const [code, message] = course;
			const unknown = code === 'assignment-course-unverified';
			if (unknown) unverified++;
			else checkedItems.push({file:path, subject:courseSubject, outcome:message});
			findings.push({severity:unknown ? 'info' : 'warning', code, file:path, message});
		}
		const dueValid = validDate(properties.due);
		const dueMessage = '已排期的作业需要有效的 YYYY-MM-DD 截止日期。';
		checkedItems.push({file:path, subject:'已排期作业的 due 日期', outcome:dueValid ? '日期有效：' + properties.due : dueMessage});
		if (!dueValid) findings.push({severity:'warning', code:'assignment-due-invalid', file:path, message:dueMessage});
	}
	return {findings, unverified, checkedItems};
}
