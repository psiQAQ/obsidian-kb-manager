function hasOpenTask(body) {
	let fence;
	for (const line of body.split(/\r?\n/u)) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence) {
			if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
			continue;
		}
		if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
			fence = marker[1];
			continue;
		}
		if (/^[ \t]*[-*+][ \t]+\[ \](?:[ \t]|$)/u.test(line)) return true;
	}
	return false;
}

export default async function check({ notes }) {
	const findings = [];
	const checkedItems = [];
	for (const {path, body, properties} of notes) {
		if (!path.startsWith('Archives/') || properties.type !== 'review-project') continue;
		const open = hasOpenTask(body);
		const message = '归档项目仍有未完成的行动。';
		checkedItems.push({file:path, subject:'归档项目正文里的待办复选框', outcome:open ? message : '未发现未完成的行动。'});
		if (open) findings.push({severity:'warning', code:'archived-project-open-task', file:path, message});
	}
	return {findings, checkedItems};
}
