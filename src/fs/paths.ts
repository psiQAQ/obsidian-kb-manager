import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { segments } from './segments.ts';
export { segments } from './segments.ts';

export async function statIfPresent(file: string) {
	try { return await fs.lstat(file); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function existingDirectory(root: string, relative: string): Promise<string> {
 let current = await fs.realpath(root);
 for (const part of segments(relative)) {
  current = path.join(current, part);
  const stat = await fs.lstat(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(fromEnglish('Expected a real directory: ','预期真实目录：') + part);
 }
 return current;
}
