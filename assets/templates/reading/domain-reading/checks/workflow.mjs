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
				lines.some(line => /^#{1,6}\s/u.test(line));
		})) {
			findings.push({ severity:'warning', code:'review-card-incomplete', file:path, message:'标题后留空行。每组的问题、? 和答案连续书写，组与组之间留空行。' });
		}
		return findings;
	});
}
