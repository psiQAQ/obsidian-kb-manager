export default async function check({ notes }) {
	return notes.flatMap(({ path, body, properties }) => {
		if (!path.startsWith('Terms/') || properties.type !== 'term' || properties.review !== true) return [];
		const findings = [];
		const decks = [properties.tags].flat().filter(value => typeof value === 'string')
			.map(value => value.trim().replace(/^#/u, ''))
			.filter(tag => tag === 'flashcards' || tag.startsWith('flashcards/'));
		if (decks.length !== 1 || !/^flashcards\/[^\s/#]+$/u.test(decks[0]) || decks[0] === 'flashcards/reading-example') {
			findings.push({ severity:'warning', code:'review-deck-missing', file:path, message:'请给术语设置本库专用的子卡组标签。' });
		}
		const cards = body.trim().split(/\r?\n[ \t]*\r?\n/u).map(block => block.split(/\r?\n/u).map(line => line.trim()));
		const questions = cards.filter(lines => lines.includes('?'));
		if (!questions.length || questions.some(lines => {
			const separator = lines.indexOf('?');
			return separator <= 0 || separator !== lines.lastIndexOf('?') || separator >= lines.length - 1 ||
				/^#{1,6}\s/u.test(lines[separator - 1]) || /^#{1,6}\s/u.test(lines[separator + 1]);
		})) {
			findings.push({ severity:'warning', code:'review-card-incomplete', file:path, message:'每组问答需用空行隔开，并在 ? 分隔符两侧分别填写问题和答案。' });
		}
		return findings;
	});
}
