// Recognize top-level Markdown fences before inspecting their literal content.
export function fencedBlocks(body: string, ignoreComments = false) {
	const blocks: {language: string; line: number; endLine: number; source: string; sourceStart: number; sourceEnd: number}[] = [];
	const lines = body.split(/\r?\n/u);
	let offset = 0;
	let comment: '-->' | '%%' | undefined;
	let active: {marker: string; language: string; index: number; sourceStart: number} | undefined;
	for (const [index, text] of lines.entries()) {
		const lineStart = offset;
		offset = Math.min(body.length, offset + text.length + (body[offset + text.length] === '\r' ? 2 : 1));
		const line = index ? text : text.replace(/^\uFEFF/u,'');
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (ignoreComments && !active && (!match || comment)) {
			if (!comment && !line.includes('<!--') && !line.includes('%%')) continue;
			const markers = [...line.matchAll(/\\.|`+|<!--|-->|%%/gu)];
			const backticks = new Map<string,number>();
			const closingBacktick = new Map<number,number>();
			for (let i = markers.length - 1; i >= 0; i--) {
				const marker = markers[i]![0];
				if (!marker.startsWith('`')) continue;
				const closing = backticks.get(marker);
				if (closing !== undefined) closingBacktick.set(i,closing);
				backticks.set(marker,i);
			}
			for (let i = 0; i < markers.length; i++) {
				const marker = markers[i]![0];
				if (comment) {if (marker === comment) comment = undefined;}
				else if (marker === '<!--' || marker === '%%') comment = marker === '<!--' ? '-->' : '%%';
				else i = closingBacktick.get(i) ?? i;
			}
			continue;
		}
		if (!match) continue;
		const [, marker = '', info = ''] = match;
		if (active) {
			if (marker[0] !== active.marker[0] || marker.length < active.marker.length || info.trim()) continue;
			blocks.push({language:active.language, line:active.index + 1, endLine:index + 1, source:lines.slice(active.index + 1,index).join('\n'),
				sourceStart:active.sourceStart, sourceEnd:lineStart});
			active = undefined;
		} else if (marker[0] !== '`' || !info.includes('`')) {
			active = {marker, language:info.trim().toLowerCase(), index, sourceStart:offset};
		}
	}
	if (active) blocks.push({language:active.language, line:active.index + 1, endLine:lines.length, source:lines.slice(active.index + 1).join('\n'),
		sourceStart:active.sourceStart, sourceEnd:body.length});
	return blocks;
}
