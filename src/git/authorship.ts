import * as path from 'node:path';
import { checkedNative } from './network-native.ts';
import type { GitPreferences } from '../preferences.ts';
import { fromEnglish } from '../i18n.ts';

export interface LineCredit {
	line: number;
	oid: string;
	author: string;
	timestamp: number;
	offset: string;
	summary: string;
}

export function parseLineCredits(output: string): LineCredit[] {
	const result: LineCredit[] = [];
	let current: LineCredit | undefined;
	for (const row of output.split('\n')) {
		const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/u.exec(row);
		if (header) {
			current = {oid:header[1]!,line:Number(header[2]),author:'',timestamp:0,offset:'+0000',summary:''};
			continue;
		}
		if (!current) continue;
		if (row.startsWith('author ')) current.author = row.slice(7);
		if (row.startsWith('author-time ')) current.timestamp = Number(row.slice(12));
		if (row.startsWith('author-tz ')) current.offset = row.slice(10);
		if (row.startsWith('summary ')) current.summary = row.slice(8);
		if (row.startsWith('\t')) {
			if (!/^0+$/u.test(current.oid)) result.push(current);
			current = undefined;
		}
	}
	return result;
}

export async function lineCredits(dir: string, file: string, first: number, last: number, document: string,
	prefs: Pick<GitPreferences,'blameFollow'|'blameIgnoreWhitespace'>) {
	if (path.isAbsolute(file) || /[\\:\0]/u.test(file) || file.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'))
		throw new Error(fromEnglish('Invalid library-relative file','文件不在知识库内或路径无效'));
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first)
		throw new Error(fromEnglish('Invalid line range','行号范围无效'));
	const run = await checkedNative(dir);
	const tracked = await run(['ls-files','--',file]);
	if (!tracked.trim()) return [];
	const flags = prefs.blameIgnoreWhitespace ? ['-w'] : [];
	if (prefs.blameFollow !== 'inactive') {
		flags.push('-C');
		if (prefs.blameFollow === 'all-commits') flags.push('-C');
		flags.push('-C40');
	}
	const output = await run(['blame','--line-porcelain','--contents','-',...flags,'-L',first + ',' + last,'--',file],undefined,document);
	return parseLineCredits(output);
}

export function displayAuthor(name: string, style: GitPreferences['blameAuthor']): string {
	const parts = name.trim().split(/\s+/u);
	switch (style) {
		case 'hidden': return '';
		case 'initials': return parts.map(p => Array.from(p)[0] ?? '').join('');
		case 'first': return parts[0] ?? '';
		case 'last': return parts[parts.length-1] ?? '';
		case 'full': return name;
	}
}

export function ageColor(credit: LineCredit, prefs: Pick<GitPreferences,'blameMaxDays'|'blameOld'|'blameNew'>, now: number): string {
	const portion = Math.max(0,Math.min(1,(now / 1000 - credit.timestamp) / (86400 * prefs.blameMaxDays)));
	const channels = [1,3,5].map(start => {
		const recent = parseInt(prefs.blameNew.slice(start,start+2),16);
		const oldest = parseInt(prefs.blameOld.slice(start,start+2),16);
		return Math.round(recent + portion * (oldest-recent));
	});
	return 'rgb(' + channels.join(',') + ')';
}
