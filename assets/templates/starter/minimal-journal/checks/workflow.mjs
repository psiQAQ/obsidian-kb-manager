export default async function check({ notes }) {
	return notes.flatMap(({ path, properties }) => {
		const year = /^Notes\/(\d{4})\//u.exec(path)?.[1];
		if (!year || properties.type !== 'jot') return [];
		if (typeof properties.date === 'string' && properties.date.startsWith(year + '-')) return [];
		return [{ severity:'warning', code:'archive-year-mismatch', file:path, message:'札记的 date 应落在它所在的年度目录。' }];
	});
}
