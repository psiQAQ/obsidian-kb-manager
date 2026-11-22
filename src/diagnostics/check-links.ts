import {dynamicTarget, linkRequest, linkResolver, staticOccurrences} from './links.ts';
import {diagnosticCheckpoint} from './checkpoint.ts';
import type {EvidenceOptions} from './provenance.ts';
import type {Inventory} from './snapshot.ts';
import {printable} from './types.ts';
import type {CheckContext, CheckLinkEvidence, LinkOccurrence} from './types.ts';

export async function collectCheckLinkEvidence(options: EvidenceOptions, inventory: Inventory, root: string, libraryPath: string) {
	const checkpoint = diagnosticCheckpoint(options.signal);
	const {resolve, vaultPath} = linkResolver(options, inventory, root, libraryPath);
	const notes = new Map(inventory.notes.map(note => [vaultPath(note.path), note]));
	const links: NonNullable<CheckContext['links']> = Object.create(null) as NonNullable<CheckContext['links']>;
	for (const note of inventory.notes) {
		const pause = checkpoint?.();
		if (pause) await pause;
		if (!note.properties) continue;
		const source = vaultPath(note.path);
		let native: LinkOccurrence[] | undefined;
		try {native = await options.collectLinks?.(source);} catch {/* Keep static evidence with incomplete coverage. */}
		const references: CheckLinkEvidence[] = [];
		links[note.path] = {complete: !options.collectLinks || native !== undefined, references};
		for (const occurrence of native ?? staticOccurrences(note)) {
			const pause = checkpoint?.();
			if (pause) await pause;
			const evidence: CheckLinkEvidence = {status: 'unknown', line: occurrence.line,
				target: printable(occurrence.target, 1000) ? occurrence.target : undefined};
			try {
				const link = linkRequest(source, occurrence);
				if (!link) continue;
				if (!dynamicTarget(link.target) && !dynamicTarget(link.fragment ?? '')) {
					const found = await resolve(note.path, link);
					evidence.status = found.status;
					if (found.status === 'resolved' && found.path) {
						evidence.path = found.path;
						if (/\.md$/iu.test(found.path)) {
							const local = notes.get(found.path);
							const visibility = local ? local.properties?.visibility : await options.linkTargetVisibility?.(found.path);
							if (visibility === 'public' || visibility === 'private') evidence.visibility = visibility;
						}
					}
				}
			} catch {options.signal?.throwIfAborted();}
			references.push(evidence);
		}
	}
	return links;
}
