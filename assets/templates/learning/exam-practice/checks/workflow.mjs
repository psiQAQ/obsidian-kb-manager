export default async function check({ notes }) {
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Practice/') || properties.type !== 'exam-practice' || properties.status !== 'mastered') return [];
		if (Array.isArray(properties.attempts) && properties.attempts.some(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value))) return [];
		return [{ severity:'warning', code:'retry-record-missing', file:path, message:'标记已掌握之前，请在 attempts 中记录一次复做日期。' }];
	});
}
