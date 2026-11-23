export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (properties.type !== 'gtd-action' || properties.status !== 'waiting' ||
			path.startsWith('Templates/') || path.startsWith('Integrations/')) continue;
		const inActions = path.startsWith('Actions/');
		const locationMessage = '等待中的行动应放在本库 Actions 目录中。';
		checkedItems.push({file:path, subject:'等待中行动的位置', outcome:inActions ? '位于本库 Actions 目录中。' : locationMessage});
		if (!inActions) findings.push({severity:'warning', code:'waiting-action-outside-actions', file:path, message:locationMessage});
		const follow = properties.follow_up;
		const date = typeof follow === 'string' ? new Date(follow + 'T00:00:00Z') : new Date(NaN);
		const valid = !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === follow;
		const message = '等待中的行动需要填写有效的 follow_up 日期。';
		checkedItems.push({file:path, subject:'等待中行动的 follow_up 日期', outcome:valid ? '日期有效：' + follow : message});
		if (!valid) findings.push({severity:'warning', code:'waiting-follow-up-missing', file:path, message});
	}
	return {findings, checkedItems};
}
