import type { StructuredPatchHunk } from 'diff';

export interface PatchLine {
	kind: 'added' | 'removed' | 'context';
	text: string;
	oldNumber?: number;
	newNumber?: number;
	noNewline: boolean;
}

export function numberedLines(hunk: StructuredPatchHunk): PatchLine[] {
	const lines: PatchLine[] = [];
	let oldNumber = hunk.oldStart, newNumber = hunk.newStart;
	for (const content of hunk.lines) {
		if (content.startsWith('\\')) {
			const previous = lines.at(-1);
			if (previous) previous.noNewline = true;
			continue;
		}
		const kind = content.startsWith('+') ? 'added' : content.startsWith('-') ? 'removed' : 'context';
		lines.push({kind, text: content.slice(1), noNewline: false,
			oldNumber: kind === 'added' ? undefined : oldNumber++,
			newNumber: kind === 'removed' ? undefined : newNumber++});
	}
	return lines;
}

export function* pairedLines(lines: readonly PatchLine[]): Generator<[PatchLine | undefined, PatchLine | undefined]> {
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line.kind === 'context') {
			yield [line, line];
			index++;
			continue;
		}
		const removed = index;
		while (lines[index]?.kind === 'removed') index++;
		const added = index;
		while (lines[index]?.kind === 'added') index++;
		for (let i = 0; i < Math.max(added - removed, index - added); i++) {
			yield [removed + i < added ? lines[removed + i] : undefined, added + i < index ? lines[added + i] : undefined];
		}
	}
}
