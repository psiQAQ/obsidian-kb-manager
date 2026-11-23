const stages = new Set(['hold', 'assess', 'trial', 'adopt']);

export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, properties} of notes) {
		if (!path.startsWith('Radar/') || properties.type !== 'radar-tool') continue;
		const {status, adoption_reason: reason} = properties;
		const valid = stages.has(status);
		const stageMessage = '请使用 hold、assess、trial 或 adopt。';
		checkedItems.push({file:path, subject:'雷达条目的 status 阶段', outcome:valid ? '阶段有效：' + status : stageMessage});
		if (!valid) findings.push({severity:'warning', code:'radar-stage-invalid', file:path, message:stageMessage});
		if (status !== 'adopt') continue;
		const supported = typeof reason === 'string' && !!reason.trim();
		const message = '已采用的条目需要在 adoption_reason 留下采用依据。';
		checkedItems.push({file:path, subject:'采用工具的 adoption_reason', outcome:supported ? '已填写采用依据。' : message});
		if (!supported) findings.push({severity:'warning', code:'radar-adoption-unsupported', file:path, message});
	}
	return {findings, checkedItems};
}
