const stages = new Set(['hold', 'assess', 'trial', 'adopt']);

export default async function check({ notes }) {
	return notes.flatMap(({ path, properties }) => {
		if (!path.startsWith('Radar/') || properties.type !== 'radar-tool') return [];
		if (!stages.has(properties.status)) return [{ severity:'warning', code:'radar-stage-invalid', file:path, message:'请使用 hold、assess、trial 或 adopt。' }];
		if (properties.status !== 'adopt' || (typeof properties.adoption_reason === 'string' && properties.adoption_reason.trim())) return [];
		return [{ severity:'warning', code:'radar-adoption-unsupported', file:path, message:'已采用的条目需要在 adoption_reason 留下采用依据。' }];
	});
}
