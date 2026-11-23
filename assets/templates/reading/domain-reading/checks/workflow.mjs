export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, body, properties} of notes) {
		if (!path.startsWith('Terms/') || properties.type !== 'term' || properties.review !== true) continue;
		const decks = [properties.tags].flat().filter(value => typeof value === 'string')
			.map(value => value.trim().replace(/^#/u, ''))
			.filter(tag => tag === 'flashcards' || tag.startsWith('flashcards/'));
		const deckValid = decks.length === 1 && /^flashcards\/[^\s/#]+$/u.test(decks[0]) && decks[0] !== 'flashcards/reading-example';
		const deckMessage = '请给术语设置本库专用的子卡组标签。';
		checkedItems.push({file:path, subject:'待复习术语的 tags 子卡组标签', outcome:deckValid ? '已设置单独的子卡组标签。' : deckMessage});
		if (!deckValid) findings.push({severity:'warning', code:'review-deck-missing', file:path, message:deckMessage});
		const cards = body.trim().split(/\r?\n[ \t]*\r?\n/u).map(block => block.split(/\r?\n/u).map(line => line.trim()));
		const questions = cards.filter(lines => lines.includes('?'));
		const cardsInvalid = !questions.length || questions.some(lines => {
			const separator = lines.indexOf('?');
			return separator <= 0 || separator !== lines.lastIndexOf('?') || separator >= lines.length - 1 ||
				lines.some(line => /^#{1,6}\s/u.test(line));
		});
		const cardsMessage = '标题后留空行。每组的问题、? 和答案连续书写，组与组之间留空行。';
		checkedItems.push({file:path, subject:'待复习术语正文的问答格式', outcome:cardsInvalid ? cardsMessage : `检查了 ${questions.length} 组问答，格式符合规则。`});
		if (cardsInvalid) findings.push({severity:'warning', code:'review-card-incomplete', file:path, message:cardsMessage});
	}
	return {findings, checkedItems};
}
