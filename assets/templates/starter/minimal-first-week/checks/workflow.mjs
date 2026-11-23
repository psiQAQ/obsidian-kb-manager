export default async function check({ notes }) {
	const diaries = notes.filter(note => note.path.startsWith('Journal/') && note.properties.type === 'daily-note');
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of diaries) {
		const date = properties.date;
		const matches = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date) && path === 'Journal/' + date + '.md';
		const message = '每日记录应命名为 YYYY-MM-DD.md，且与 date 一致。';
		checkedItems.push({file:path, subject:'每日记录的 date 与文件名', outcome:matches ? '日期与文件名一致。' : message});
		if (!matches) findings.push({severity:'warning', code:'journal-date-mismatch', file:path, message});
	}
	const home = notes.find(note => note.path === 'README.md');
	if (home) {
		const link = /\[日记入口\]\(\.\/(Journal\/[^)\s#]+\.md)\)/u.exec(home.body)?.[1];
		const matches = diaries.some(note => note.path === link);
		const message = '在首页保留名为“日记入口”的相对 Markdown 链接，指向本库 Journal 中的日记。';
		checkedItems.push({file:home.path, subject:'首页的“日记入口”链接', outcome:matches ? '入口链接指向本库日记。' : message});
		if (!matches) findings.push({severity:'warning', code:'journal-entry-invalid', file:home.path, message});
	}
	return {findings, checkedItems};
}
