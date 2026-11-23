export default async function check({ notes }) {
	const diaries = notes.filter(note => note.path.startsWith('Journal/') && note.properties.type === 'daily-note');
	const findings = diaries.flatMap(({ path, properties }) => {
		const date = properties.date;
		if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date) && path === 'Journal/' + date + '.md') return [];
		return [{ severity:'warning', code:'journal-date-mismatch', file:path, message:'每日记录应命名为 YYYY-MM-DD.md，且与 date 一致。' }];
	});
	const home = notes.find(note => note.path === 'README.md');
	if (!home) return findings;
	const link = /\[日记入口\]\(\.\/(Journal\/[^)\s#]+\.md)\)/u.exec(home.body)?.[1];
	if (!diaries.some(note => note.path === link)) {
		findings.push({ severity:'warning', code:'journal-entry-invalid', file:home.path, message:'在首页保留名为“日记入口”的相对 Markdown 链接，指向本库 Journal 中的日记。' });
	}
	return findings;
}
