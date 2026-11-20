export default async function check({ notes }) {
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Media/') || properties.type !== 'media-item') return [];
		const { progress, total, status, rating } = properties;
		const findings = [];
		if (typeof progress === 'number' && typeof total === 'number' && (progress < 0 || progress > total || (status === 'completed' && progress !== total))) {
			findings.push({ severity:'warning', code:'invalid-media-progress', file:path, message:'校对进度与总量，标记完成时应达到总量。' });
		}
		if (typeof rating === 'number' && (rating < 0 || rating > 10)) findings.push({ severity:'warning', code:'invalid-media-rating', file:path, message:'评分范围为 0 到 10。' });
		return findings;
	});
}
