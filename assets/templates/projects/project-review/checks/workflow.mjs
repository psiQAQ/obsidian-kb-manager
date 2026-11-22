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
	return notes.flatMap(({ path, body, properties }) => {
		if (!path.startsWith('Archives/') || properties.type !== 'review-project') return [];
		if (!hasOpenTask(body)) return [];
		return [{ severity:'warning', code:'archived-project-open-task', file:path, message:'归档项目仍有未完成的行动。' }];
	});
}
