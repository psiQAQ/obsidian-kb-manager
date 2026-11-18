// Unified diff hunks count context lines in both ranges. Pair replacements
// inside each contiguous run so independent additions and deletions stay distinct.
export function hunkLines(hunk: {newStart: number; lines: string[]}) {
	const marks = new Map<number,string>();
	const counts = {added:0, changed:0, deleted:0};
	let line = Math.max(1,hunk.newStart);
	let added = 0, removed = 0;
	function flush() {
		const paired = Math.min(added,removed);
		counts.changed += paired;
		counts.added += added - paired;
		counts.deleted += removed - paired;
		for (let i = 0; i < added; i++) marks.set(line + i,i < paired ? '~' : '+');
		line += added;
		if (removed > paired) marks.set(line,'−');
		added = removed = 0;
	}
	for (const entry of hunk.lines) {
		switch (entry[0]) {
			case '+': added++; break;
			case '-': removed++; break;
			case ' ': flush(); line++; break;
		}
	}
	flush();
	return {marks,counts};
}
