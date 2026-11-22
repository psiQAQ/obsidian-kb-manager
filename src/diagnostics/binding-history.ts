import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {guardGit} from '../git/guard.ts';
import {gitResult} from '../git/network-native.ts';
import {hash} from './snapshot.ts';

const maxVersions = 16;
const maxHistoryReads = 32;
const oid = /^[0-9a-f]{40}$/u;

/** Historical bytes are only evidence if they match the instance's recorded fingerprint. */
export function bindingHistory(root: string, vaultRoot?: string, signal?: AbortSignal) {
	const gitDir = join(root,'.git');
	let ready: Promise<boolean> | undefined;
	let deadline: AbortSignal | undefined;
	let remaining = maxHistoryReads;
	async function localRepository() {
		try {
			if (!(await lstat(gitDir)).isDirectory()) return false;
			if ((await lstat(join(gitDir,'config'))).size > 512*1024) return false;
			for (const name of ['commondir','gitdir','objects/info/alternates','objects/info/http-alternates']) {
				if (await lstat(join(gitDir,name)).then(() => true, (error: NodeJS.ErrnoException) => {
					if (error.code !== 'ENOENT') throw error;
					return false;
				})) return false;
			}
			await guardGit(root,undefined,true);
			return true;
		} catch {signal?.throwIfAborted(); return false;}
	}
	const git = async (args: string[]) => {
		deadline ??= AbortSignal.timeout(8000);
		const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
		return (await gitResult(root,args,{signal:combined,vaultRoot,historyRead:true})).stdout;
	};
	return async (file: string, saved: string) => {
		if (remaining <= 0 || deadline?.aborted || !/^[a-f0-9]{64}$/u.test(saved) || !(await (ready ??= localRepository()))) return undefined;
		try {
			remaining--;
			const revisions = (await git(['log',`--max-count=${maxVersions}`,'--format=%H','--no-show-signature',
				'--no-notes','--no-ext-diff','HEAD','--',file])).toString().trim().split('\n');
			for (const revision of revisions) {
				if (remaining <= 0 || deadline?.aborted) break;
				if (!oid.test(revision)) continue;
				remaining--;
				// cat-file reads the raw blob, with no checkout filters or text conversion.
				const bytes = await git(['cat-file','blob',revision + ':' + file]).catch(() => undefined);
				signal?.throwIfAborted();
			if (!bytes) continue;
			if (hash(bytes) === saved) return bytes;
			const lf = bytes.toString('utf8').replace(/\r\n/gu,'\n');
			for (const text of [lf,lf.replace(/\n/gu,'\r\n')]) {
				const normalized = Buffer.from(text);
				if (hash(normalized) === saved) return normalized;
			}
			}
		} catch {signal?.throwIfAborted();}
		return undefined;
	};
}
