import type {DiagnosticExclusion, DiagnosticExclusionCheck} from '../kb/template-declaration.ts';
import {diagnosticCheckpoint} from './checkpoint.ts';
import {fencedBlocks} from './fences.ts';
import type {Inventory} from './snapshot.ts';

const sourceExtensions = {
	links: /\.md$/iu,
	anchors: /\.md$/iu,
	portability: /\.(?:md|canvas)$/iu,
	bases: /\.(?:md|base)$/iu,
} satisfies Record<DiagnosticExclusionCheck, RegExp>;

export function supportsSourceExclusions(id: string): id is DiagnosticExclusionCheck {
	return Object.prototype.hasOwnProperty.call(sourceExtensions,id);
}

export function templateSourceMatches(rules: readonly DiagnosticExclusion[] = []) {
	const paths = new Map<string,{files:Set<string>; folders:Set<string>}>();
	for (const {checks,files,folders} of rules) for (const id of checks) {
		let scope = paths.get(id);
		if (!scope) paths.set(id, scope = {files:new Set(), folders:new Set()});
		for (const file of files ?? []) scope.files.add(file);
		for (const folder of folders ?? []) scope.folders.add(folder);
	}
	function match(id: string, file: string) {
		const scope = paths.get(id);
		if (!scope) return [];
		const matches = [];
		if (scope.files.has(file)) matches.push(`files:${file}`);
		for (let slash = file.indexOf('/'); slash >= 0; slash = file.indexOf('/',slash+1)) {
			const folder = file.slice(0,slash);
			if (scope.folders.has(folder)) matches.push(`folders:${folder}`);
		}
		return matches;
	}
	return {match, has:(id: string) => paths.has(id)};
}

export async function excludedDiagnosticSources(inventory: Inventory, selected: readonly string[],
	{has,match}: ReturnType<typeof templateSourceMatches>, signal?: AbortSignal) {
	const scopes = new Map<string,{files:Map<string,string[]>; allExcluded:boolean}>();
	const checkpoint = diagnosticCheckpoint(signal);
	for (const id of selected) {
		if (!has(id) || !supportsSourceExclusions(id)) continue;
		const files = new Map<string,string[]>();
		let hasIncluded = false;
		const notes = id === 'bases' ? new Map(inventory.notes.map(note => [note.path,note])) : undefined;
		for (const file of inventory.files) {
			if (!sourceExtensions[id].test(file)) continue;
			const pause = checkpoint?.();
			if (pause) await pause;
			const matches = match(id,file);
			if (notes && /\.md$/iu.test(file)) {
				const note = notes.get(file);
				// A failed read or an unclosed header may conceal an embedded Base.
				if (!note || note.problem?.code === 'unclosed-frontmatter') {hasIncluded = true; continue;}
				if (!fencedBlocks(note.body,true).some(block => block.language === 'base')) continue;
			}
			if (matches.length) files.set(file,matches);
			else hasIncluded = true;
		}
		if (files.size) scopes.set(id,{files,allExcluded:!hasIncluded});
	}
	return scopes;
}

export type SourceInclusion = (id: string, file: string) => boolean;
