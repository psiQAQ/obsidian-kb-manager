import {parse} from 'yaml';
import {key} from '../fs/vault.ts';
import {scanBasePaths} from '../kb/base-paths.ts';
import type {BasePathReference} from '../kb/base-paths.ts';
import {diagnosticCheckpoint} from './checkpoint.ts';
import {reportUnreadableNotes} from './coverage.ts';
import {fencedBlocks} from './fences.ts';
import type {EvidenceOptions} from './provenance.ts';
import {decode, entryVersion, readRelative, relativeEntry, relativePath, unavailableVersion} from './snapshot.ts';
import type {Inventory, libraryLocation} from './snapshot.ts';
import {result} from './types.ts';
import type {DiagnosticCheckResult} from './types.ts';

type Location = Awaited<ReturnType<typeof libraryLocation>>;
type FolderStatus = 'resolved' | 'missing' | 'unverified';

function folderLookup({root,vault,relative,identifiedVault,configDir}: Location, {signal,trace}: EvidenceOptions) {
	const seen = new Map<string,Promise<FolderStatus>>();
	async function lookup(folder: string): Promise<FolderStatus> {
		if (!identifiedVault || !relativePath(folder) || folder.split('/').some(part => key(part) === key(configDir))) return 'unverified';
		if (folder === relative) return 'resolved';
		const inLibrary = !relative || folder.startsWith(relative + '/');
		const path = inLibrary && relative ? folder.slice(relative.length + 1) : folder;
		if (!inLibrary) trace?.untracked();
		try {
			const {stat} = await relativeEntry(inLibrary ? root : vault,path,signal);
			if (inLibrary) trace?.file(path,entryVersion(stat));
			return stat.isDirectory() ? 'resolved' : 'missing';
		} catch (error) {
			signal?.throwIfAborted();
			const state = unavailableVersion(error);
			if (inLibrary) trace?.file(path,state);
			return state === 'missing' ? 'missing' : 'unverified';
		}
	}
	return (folder: string) => {
		let status = seen.get(folder);
		if (!status) {
			status = lookup(folder);
			seen.set(folder,status);
		}
		return status;
	};
}

function baseData(text: string) {
	try {
		const data: unknown = parse(text);
		// Share plain JSON data with installed common rules.
		return JSON.parse(JSON.stringify(data)) as unknown;
	} catch {return undefined;}
}

export async function readBaseEvidence(options: EvidenceOptions, location: Location, inventory: Inventory,
	check: DiagnosticCheckResult, templateDirs: readonly string[], includes: (file: string) => boolean) {
	const {root} = location;
	const {signal,trace} = options;
	const checkpoint = diagnosticCheckpoint(signal);
	const lookup = folderLookup(location,options);
	async function inspectPath({argument,kind,expression,field,line,column,wholeFilter,exclusion}: BasePathReference, lineOffset: number, inTemplate: boolean) {
		const value = argument?.value;
		const evidence = {kind,expression:expression.slice(0,512),field,line:line + lineOffset,column,value:value?.slice(0,2048)};
		if (value === undefined) return {...evidence,status:'unverified'};
		if (/\{\{[^{}]+\}\}|<%[\s\S]*?%>|__[A-Z][A-Z0-9_]*__/u.test(value))
			return {...evidence,status:'unverified',placeholder:inTemplate ? 'deferred' : 'unsubstituted',wholeFilter};
		if (/^\.\.?\//u.test(value)) return {...evidence,status:'relative'};
		// An arbitrary startsWith prefix may be a partial file name. Only a
		// slash-terminated prefix unambiguously names a folder to check.
		if (kind === 'startsWith' && !value.endsWith('/')) return undefined;
		if (kind === 'inFolder' && value === '/') return {...evidence,status:'resolved'};
		const folder = value.replace(/\/$/u,'');
		const status = await lookup(folder);
		return {...evidence,status,...(status === 'missing' && exclusion && {exclusion})};
	}
	async function inspect(file: string, text: string, lineOffset: number) {
		const paths = [];
		const data = baseData(text);
		const inTemplate = templateDirs.some(dir => file.startsWith(dir + '/'));
		if (data !== undefined) for (const reference of scanBasePaths(text,'base')) {
			const pause = checkpoint?.();
			if (pause) await pause;
			const path = await inspectPath(reference,lineOffset,inTemplate);
			if (path) paths.push(path);
		}
		return {data,paths};
	}
	const noteCoverage = result({id:check.id,name:check.name});
	reportUnreadableNotes(noteCoverage,inventory);
	const files = [];
	let remaining = 24 * 1024 * 1024;
	for (const file of inventory.files) {
		if (!file.toLowerCase().endsWith('.base') || !includes(file)) continue;
		let text: string;
		try {
			const bytes = await readRelative(root,file,Math.min(remaining,2 * 1024 * 1024),signal,trace);
			remaining -= bytes.length;
			text = decode(bytes);
		} catch {signal?.throwIfAborted(); files.push({file,unreadable:true}); continue;}
		files.push({file,...await inspect(file,text,0)});
	}
	const notes = [];
	for (const {path:file,problem,body,lineOffset} of inventory.notes) {
		if (!includes(file)) continue;
		const pause = checkpoint?.();
		if (pause) await pause;
		const blocks = [];
		for (const {language,line,sourceStart,sourceEnd} of fencedBlocks(body,true)) {
			if (language !== 'base') continue;
			blocks.push({line:line + lineOffset,...await inspect(file,body.slice(sourceStart,sourceEnd),line + lineOffset)});
		}
		notes.push({file,problem,blocks});
	}
	return {result:check,files,notes,noteCoverage};
}
