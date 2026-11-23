export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (!path.startsWith('Practice/') || properties.type !== 'exam-practice' || properties.status !== 'mastered') continue;
		const attempt = Array.isArray(properties.attempts) && properties.attempts.find(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value));
		const message = '标记已掌握之前，请在 attempts 中记录一次复做日期。';
		checkedItems.push({file:path, subject:'已掌握习题的 attempts 复做日期', outcome:attempt ? '已记录日期：' + attempt : message});
		if (!attempt) findings.push({severity:'warning', code:'retry-record-missing', file:path, message});
	}
	return {findings, checkedItems};
}
