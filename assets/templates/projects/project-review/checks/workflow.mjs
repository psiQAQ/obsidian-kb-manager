export default async function check({ notes }) {
	return notes.flatMap(({ path, body, properties }) => {
		if (!path.startsWith('Archives/') || properties.type !== 'review-project') return [];
		const prose = body.replace(/^\s*(?:`{3,}|~{3,}).*$[\s\S]*?^\s*(?:`{3,}|~{3,}).*$/gmu, '');
		if (!/^\s*[-*+]\s+\[ \]/mu.test(prose)) return [];
		return [{ severity:'warning', code:'archived-project-open-task', file:path, message:'归档项目仍有未完成的行动。' }];
	});
}
