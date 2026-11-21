export default function check({ notes, links }) {
	const findings = [];
	let unverified = 0;
	for (const { path, properties } of notes) {
		if (properties.type !== 'garden-note' || properties.publish_ready !== true) continue;
		const source = links?.[path];
		if (!source?.complete) {
			unverified++;
			findings.push({severity:'info', code:'sharing-reference-unverified', file:path, message:'该页面的链接清单未能完整核实。'});
		}
		const seen = new Set();
		for (const reference of source?.references ?? []) {
			if (reference.status === 'missing' || reference.visibility === 'public' ||
				(reference.path && !/\.md$/iu.test(reference.path))) continue;
			const target = reference.path ?? reference.target;
			if (seen.has(target)) continue;
			seen.add(target);
			const position = {file:path, line:reference.line, evidence:target?.slice(0, 1000)};
			if (reference.visibility === 'private') {
				findings.push({...position, severity:'warning', code:'sharing-private-reference', message:'拟分享页面引用了明确标记为私有的页面。'});
			} else {
				unverified++;
				findings.push({...position, severity:'info', code:'sharing-reference-unverified',
					message:reference.path ? '未能确认链接目标的 visibility 属性。' : '未能核实该链接指向的实际页面。'});
			}
		}
	}
	return {findings, unverified};
}
