// Recognize top-level Markdown fences before inspecting their literal content.
export function fencedBlocks(body: string) {
	const blocks: {language: string; line: number; source: string}[] = [];
	const lines = body.split(/\r?\n/u);
	let active: {marker: string; language: string; index: number} | undefined;
	for (const [index, text] of lines.entries()) {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
		if (!match) continue;
		const [, marker = '', info = ''] = match;
		if (active) {
			if (marker[0] !== active.marker[0] || marker.length < active.marker.length || info.trim()) continue;
			blocks.push({language:active.language, line:active.index + 1, source:lines.slice(active.index + 1,index).join('\n')});
			active = undefined;
		} else if (marker[0] !== '`' || !info.includes('`')) {
			active = {marker, language:info.trim().toLowerCase(), index};
		}
	}
	if (active) blocks.push({language:active.language, line:active.index + 1, source:lines.slice(active.index + 1).join('\n')});
	return blocks;
}
