export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (!path.startsWith('Actions/') || properties.type !== 'gtd-action' || properties.status !== 'waiting') continue;
		const follow = properties.follow_up;
		const date = typeof follow === 'string' ? new Date(follow + 'T00:00:00Z') : new Date(NaN);
		const valid = !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === follow;
		const message = '等待中的行动需要填写有效的 follow_up 日期。';
		checkedItems.push({file:path, subject:'等待中行动的 follow_up 日期', outcome:valid ? '日期有效：' + follow : message});
		if (!valid) findings.push({severity:'warning', code:'waiting-follow-up-missing', file:path, message});
	}
	return {findings, checkedItems};
}
