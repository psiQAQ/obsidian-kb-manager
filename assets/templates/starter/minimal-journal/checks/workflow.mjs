export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		const year = /^Notes\/(\d{4})\//u.exec(path)?.[1];
		if (!year || properties.type !== 'jot') continue;
		const matches = typeof properties.date === 'string' && properties.date.startsWith(year + '-');
		const message = '札记的 date 应落在它所在的年度目录。';
		checkedItems.push({file:path, subject:'札记的 date 与年度目录', outcome:matches ? 'date 的年份与目录一致。' : message});
		if (!matches) findings.push({severity:'warning', code:'archive-year-mismatch', file:path, message});
	}
	return {findings, checkedItems};
}
