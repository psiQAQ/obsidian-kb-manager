import {parse} from 'yaml';
import {isRecord} from './types.ts';

export function baseViewNames(text: string): ReadonlySet<string> | undefined {
	try {
		const base: unknown = parse(text);
		if (!isRecord(base) || (base.views !== undefined && !Array.isArray(base.views))) return undefined;
		const views = (base.views ?? []) as unknown[];
		const names = new Set<string>();
		for (const view of views) {
			if (!isRecord(view) || typeof view.name !== 'string') return undefined;
			names.add(view.name);
		}
		return names;
	} catch {return undefined;}
}

export function baseViewStatus(text: string, fragment: string): 'resolved' | 'missing' | 'unknown' {
	const views = baseViewNames(text);
	return views ? views.has(fragment.slice(1)) ? 'resolved' : 'missing' : 'unknown';
}
