import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import { statIfPresent } from './vault.ts';

// POSIX rename replaces an existing empty directory. Reserve the name first.
export async function renameNewDirectory(source: string, target: string): Promise<void> {
	if (process.platform === 'win32') {
		if (await statIfPresent(target)) throw new Error(tr('目标已存在：','Destination already exists: ') + target);
		await fs.rename(source,target);
		return;
	}
	await fs.mkdir(target,{mode:0o700});
	const reserved = await fs.lstat(target,{bigint:true});
	try {
		const current = await fs.lstat(target,{bigint:true});
		if (!current.isDirectory() || current.dev!==reserved.dev || current.ino!==reserved.ino) throw new Error(tr('目标预留目录已变化','The reserved destination directory changed'));
		await fs.rename(source,target);
	} catch(error) {
		const remaining=await fs.lstat(target,{bigint:true}).catch(()=>undefined);
		if (remaining?.isDirectory() && remaining.dev===reserved.dev && remaining.ino===reserved.ino) {
			try { await fs.rmdir(target); } catch { /* Preserve newly added content. */ }
		}
		throw error;
	}
}
