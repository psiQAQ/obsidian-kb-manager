import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {commonRuleDigests, diagnosticEngineVersion} from '../kb/common-rules.ts';
import {directoryVersion, entryVersion, libraryLocation, relativeEntry, relativePath, unavailableVersion} from './snapshot.ts';
import {isRecord} from './types.ts';
import type {DiagnosticOptions, DiagnosticReport, DiagnosticInputVersion, DiagnosticRuleVersion} from './types.ts';

const maxInputs = 20000;
const maxPathLength = 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/u;
type Observations = ReadonlyMap<string,string>;

function fingerprint(libraryPath: string, files: Observations, folders: Observations) {
	const version = createHash('sha256');
	for (const items of [files,folders]) {
		for (const path of [...items.keys()].sort()) version.update(JSON.stringify([path,items.get(path)]));
		version.update('\n');
	}
	return version.update(JSON.stringify(libraryPath)).digest('hex');
}

export function traceDiagnosticInputs() {
	const files = new Map<string,string>();
	const folders = new Map<string,string>();
	let consistent = true;
	let pathLength = 0;
	const record = (items: Map<string,string>, path: string, value: string) => {
		if (!consistent || path === '.log' || path.startsWith('.log/')) return;
		const previous = items.get(path);
		if (previous === undefined) pathLength += path.length + 4;
		if (previous === undefined ? files.size + folders.size >= maxInputs : previous !== value) consistent = false;
		if (pathLength > maxPathLength) consistent = false;
		if (consistent) items.set(path,value);
	};
	return {
		file: (path: string, value: string) => record(files,path,value),
		directory: (path: string, value: string) => record(folders,path,value),
		untracked: () => {consistent = false;},
		finish(libraryPath: string): DiagnosticInputVersion | undefined {
			if (!consistent || !files.size && !folders.size) return;
			return {schemaVersion:1, libraryPath, fingerprint:fingerprint(libraryPath,files,folders), files:[...files.keys()].sort(), directories:[...folders.keys()].sort()};
		},
	};
}

export type InputTrace = ReturnType<typeof traceDiagnosticInputs>;
export type EvidenceOptions = DiagnosticOptions & {trace?: InputTrace};

export function validInputVersion(value: unknown): value is DiagnosticInputVersion {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.fingerprint !== 'string' || !digestPattern.test(value.fingerprint)) return false;
	if (value.libraryPath !== '' && !relativePath(value.libraryPath)) return false;
	const {files,directories} = value;
	return Array.isArray(files) && Array.isArray(directories) && files.length + directories.length <= maxInputs &&
		files.every(relativePath) && directories.every((path: unknown) => path === '' || relativePath(path));
}

export function validRuleVersion(value: unknown): value is DiagnosticRuleVersion {
	return isRecord(value) && typeof value.version === 'string' && value.version.length <= 512 &&
		(value.engine === 'legacy' || value.engine === 'bundled' || value.engine === 'node') &&
		(value.path === undefined || relativePath(value.path)) &&
		(value.digest === undefined || typeof value.digest === 'string' && digestPattern.test(value.digest)) &&
		(value.sourceDigest === undefined || typeof value.sourceDigest === 'string' && digestPattern.test(value.sourceDigest));
}

export type DiagnosticFreshness = 'fresh' | 'stale' | 'unknown';

export async function diagnosticFreshness(options: Pick<DiagnosticOptions,'libraryRoot'|'vaultRoot'|'configDir'|'signal'>,
	report: DiagnosticReport): Promise<DiagnosticFreshness> {
	const {inputVersion, engineVersion} = report;
	if (!inputVersion || !engineVersion) return 'unknown';
	if (diagnosticEngineVersion !== engineVersion) return 'stale';
	if (report.checks.some(({rule}) => rule?.engine === 'bundled' && rule.path && commonRuleDigests()[rule.path] !== rule.digest))
		return 'stale';
	const {signal} = options;
	try {
		const {root,relative} = await libraryLocation(options);
		if (relative !== inputVersion.libraryPath) return 'stale';
		const files = new Map<string,string>();
		for (const file of inputVersion.files) {
			try {files.set(file,entryVersion((await relativeEntry(root,file,signal)).stat));}
			catch (error) {signal?.throwIfAborted(); files.set(file,unavailableVersion(error));}
		}
		const directories = new Map<string,string>();
		for (const directory of inputVersion.directories) {
			try {
				if (directory && !(await relativeEntry(root,directory,signal)).stat.isDirectory()) return 'stale';
				signal?.throwIfAborted();
				directories.set(directory,directoryVersion(directory,await fs.readdir(join(root,directory),{withFileTypes:true})));
			} catch (error) {signal?.throwIfAborted(); directories.set(directory,unavailableVersion(error));}
		}
		signal?.throwIfAborted();
		return fingerprint(relative,files,directories) === inputVersion.fingerprint ? 'fresh' : 'stale';
	} catch {signal?.throwIfAborted(); return 'unknown';}
}
