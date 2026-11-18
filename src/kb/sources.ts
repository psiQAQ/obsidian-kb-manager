import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse } from 'yaml';
import { VaultDisk, statIfPresent } from '../fs/vault.ts';
import type { Library } from './catalog.ts';

export async function inspectSources(disk: VaultDisk, lib: Library): Promise<string[]> {
	const findings: string[] = [];
	if (!lib.mapping) return findings;
	const dirs = [lib.mapping.raw];
	if (lib.mapping.clippings) dirs.push(lib.mapping.clippings);
	dirs.push(lib.mapping.wiki);
	for (const dir of dirs) {
		const absolute = await disk.path(lib.location + '/' + dir);
		if (!(await statIfPresent(absolute))?.isDirectory()) continue;
		for (const entry of await fs.readdir(absolute, {withFileTypes:true})) {
			const relative = dir + '/' + entry.name;
			if (entry.isSymbolicLink()) { findings.push('跳过链接：' + relative); continue; }
			if (entry.isDirectory() && !entry.name.startsWith('.')) { dirs.push(relative); continue; }
			if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
			const text = await fs.readFile(await disk.path(lib.location + '/' + relative),'utf8');
			const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
			if (!front) continue;
			try {
				const metadata: unknown = parse(front);
				if (!metadata || typeof metadata !== 'object') continue;
				const data = metadata as Record<string,unknown>;
				if (dir === lib.mapping.wiki || dir.startsWith(lib.mapping.wiki + '/')) {
					const sources = data.sources;
					if (!Array.isArray(sources)) continue;
					for (const source of sources) {
						if (typeof source !== 'string') { findings.push(relative + '：来源字段格式需复核'); continue; }
						const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative),source));
						const roots = data.type === 'archive' ? [lib.mapping.wiki,lib.mapping.raw,lib.mapping.clippings] : [lib.mapping.raw,lib.mapping.clippings];
						if (!roots.some(r=>r && target.startsWith(r+'/')) ||
							!(await statIfPresent(await disk.path(lib.location+'/'+target)))?.isFile()) findings.push(relative+'：核对来源 '+source);
					}
					continue;
				}
				if (!('snapshot_source_mtime_ns' in data || 'snapshot_source_note' in data)) continue;
				const note=data.snapshot_source_note, stamp=data.snapshot_source_mtime_ns;
				if (typeof note!=='string' || !note || /^[a-z]+:|^\/|\\/iu.test(note) || typeof stamp!=='string' || !/^\d+$/u.test(stamp)) {
					findings.push(relative+'：快照元信息需复核');continue;
				}
				const target=path.posix.normalize(path.posix.join(path.posix.dirname(relative),note));
				if (!target.startsWith('Notes/')) {findings.push(relative+'：原笔记路径超出 Notes');continue;}
				const original=await disk.path(lib.location+'/'+target);
				const stat=await fs.stat(original,{bigint:true});
				if (!stat.isFile() || stat.mtimeNs!==BigInt(stamp)) findings.push(relative+'：原笔记或文件时间精度已变化');
			} catch(error) { findings.push(relative+'：'+String(error)); }
		}
	}
	return findings;
}
