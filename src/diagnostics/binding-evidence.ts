import {posix} from 'node:path';
import {baseViewStatus} from './base-view.ts';
import {bindingHistory} from './binding-history.ts';
import {verifyBindingStructure} from './binding-structure.ts';
import type {BindingStatus, CheckBindingLink} from './binding-structure.ts';
import type {EvidenceOptions} from './provenance.ts';
import {decode, entryVersion, hash, readRelative, relativeEntry, relativePath, unavailableVersion} from './snapshot.ts';
import type {libraryLocation, manifestSnapshot} from './snapshot.ts';
import {isRecord} from './types.ts';

type Manifest = Awaited<ReturnType<typeof manifestSnapshot>>;
type Location = Awaited<ReturnType<typeof libraryLocation>>;
const bindingDecoder = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

function libraryLink(root: string, location: string, options: EvidenceOptions, source: string): CheckBindingLink {
	const {signal,trace} = options;
	async function fileStatus(file: string): Promise<'file'|'missing'|'unknown'> {
		try {
			const {stat} = await relativeEntry(root,file,signal);
			trace?.file(file,entryVersion(stat));
			return stat.isFile() && stat.nlink === 1 ? 'file' : 'unknown';
		} catch (error) {
			signal?.throwIfAborted();
			trace?.file(file,unavailableVersion(error));
			return isRecord(error) && error.code === 'ENOENT' ? 'missing' : 'unknown';
		}
	}
	return async (expected, link) => {
		if (!relativePath(expected)) return 'unknown';
		const explicit = /^(?:\.\.?\/)/u.test(link.target);
		const prefix = location ? location + '/' : '';
		const direct = explicit ? posix.normalize(posix.join(posix.dirname(source),link.target)) :
			link.target.startsWith(prefix) && (prefix || link.target.includes('/')) ? link.target.slice(prefix.length) : undefined;
		let observed = direct;
		let verifiedAnchor = false;
		if (options.resolveLink) {
			try {
				const resolved = await options.resolveLink(link);
				signal?.throwIfAborted();
				if (resolved.status === 'missing' || resolved.anchor === 'missing') return 'changed';
				if (resolved.status !== 'resolved' || !resolved.path) return 'unknown';
				if (!resolved.path.startsWith(prefix)) return 'changed';
				observed = resolved.path.slice(prefix.length);
				verifiedAnchor = resolved.anchor === 'resolved';
			} catch {signal?.throwIfAborted(); return 'unknown';}
		}
		if (!observed) return 'unknown';
		if (!relativePath(observed)) return 'changed';
		const expectedNames = [expected, ...(!posix.extname(expected) ? [expected+'.md'] : [])];
		if (!expectedNames.includes(observed) && expected !== observed+'.md') return 'changed';
		let file = observed;
		let status = await fileStatus(file);
		if (status === 'missing' && !posix.extname(file)) {
			file += '.md';
			status = await fileStatus(file);
		}
		if (status !== 'file') return status === 'missing' ? 'changed' : 'unknown';
		if (link.fragment && /\.base$/iu.test(file)) {
			try {
				const anchor = baseViewStatus(decode(await readRelative(root,file,undefined,signal,trace)),link.fragment);
				return anchor === 'resolved' ? 'verified' : anchor === 'missing' ? 'changed' : 'unknown';
			} catch {signal?.throwIfAborted(); return 'unknown';}
		}
		return !link.fragment || verifiedAnchor ? 'verified' : 'unknown';
	};
}

export async function bindingEvidence(options: EvidenceOptions, location: Location, manifest: Manifest, semantic = true) {
	const {signal,trace} = options;
	const {root,relative,identifiedVault,vault} = location;
	const libraryPath = identifiedVault ? relative : undefined;
	const baseline = bindingHistory(root,identifiedVault ? vault : undefined,signal);
	const bindings = [];
	for (const binding of manifest.parsed?.identity?.managed ?? []) {
		const {path,fingerprint,root: savedRoot} = binding;
		const entry = {path,fingerprint,root:savedRoot};
		try {
			const bytes = await readRelative(root,path,undefined,signal,trace);
			const digest = hash(bytes);
			let verification: BindingStatus | undefined;
			let evidence: string | undefined;
			if (semantic) {
				verification = digest === fingerprint ? 'verified' : 'unknown';
				if (savedRoot && /\.(?:md|base)$/iu.test(path)) {
					const previous = digest === fingerprint ? bytes : await baseline(path,fingerprint);
					if (previous) {
						const scope = libraryPath ?? savedRoot;
						const observed = await verifyBindingStructure(binding,bindingDecoder.decode(previous),bindingDecoder.decode(bytes),
							scope,libraryLink(root,scope,options,path));
						if (observed.status !== 'unsupported') verification = observed.status;
						evidence = observed.evidence;
					} else {
						// An unchanged note can gain historical evidence on a later run.
						trace?.untracked();
					}
				}
			}
			bindings.push({...entry,status:'readable',digest,verification,evidence});
		} catch (error) {
			signal?.throwIfAborted();
			bindings.push({...entry,status:isRecord(error) && error.code === 'ENOENT' ? 'missing' : 'unreadable'});
		}
	}
	return {manifest:{parsed:!!manifest.parsed,reason:manifest.reason},bindings,libraryPath};
}
