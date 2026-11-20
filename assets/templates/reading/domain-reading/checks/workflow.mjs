export default async function check({ notes }) {
	return notes.flatMap(({ path, body, properties }) => {
		if (!path.startsWith('Terms/') || properties.type !== 'term' || properties.review !== true) return [];
		const card = body.split(/\r?\n/u).filter(line => line.trim());
		const separator = card.findIndex(line => line.trim() === '?');
		if (separator > 0 && separator + 1 < card.length && !card[separator - 1].startsWith('#')) return [];
		return [{ severity:'warning', code:'review-card-incomplete', file:path, message:'复习卡需要在 ? 分隔符两侧各填写一行问题和答案。' }];
	});
}
