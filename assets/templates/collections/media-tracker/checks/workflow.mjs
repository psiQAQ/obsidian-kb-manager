export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (!path.startsWith('Media/') || properties.type !== 'media-item') continue;
		const { progress, total, status, rating } = properties;
		if (typeof progress === 'number' && typeof total === 'number') {
			const invalid = progress < 0 || progress > total || (status === 'completed' && progress !== total);
			const message = '校对进度与总量，标记完成时应达到总量。';
			checkedItems.push({file:path, subject:'媒体的 progress、total 和完成状态', outcome:invalid ? message : `进度有效：${progress}/${total}`});
			if (invalid) findings.push({severity:'warning', code:'invalid-media-progress', file:path, message});
		}
		if (typeof rating === 'number') {
			const invalid = rating < 0 || rating > 10;
			const message = '评分范围为 0 到 10。';
			checkedItems.push({file:path, subject:'媒体的 rating 评分', outcome:invalid ? message : `评分在范围内：${rating}`});
			if (invalid) findings.push({severity:'warning', code:'invalid-media-rating', file:path, message});
		}
	}
	return {findings, checkedItems};
}
