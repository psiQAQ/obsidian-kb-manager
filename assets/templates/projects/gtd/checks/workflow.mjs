export default async function check({ notes }) {
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Actions/') || properties.type !== 'gtd-action' || properties.status !== 'waiting') return [];
		const follow = properties.follow_up;
		const date = typeof follow === 'string' ? new Date(follow + 'T00:00:00Z') : new Date(NaN);
		if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === follow) return [];
		return [{ severity:'warning', code:'waiting-follow-up-missing', file:path, message:'等待中的行动需要填写有效的 follow_up 日期。' }];
	});
}
