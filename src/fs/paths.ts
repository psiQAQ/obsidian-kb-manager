import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export function segments(relative: string): string[] {
 const parts = relative.split('/');
 for (const part of parts) {
  if (!part || part.startsWith('.') || part.trim() !== part || part.endsWith('.')
   || /[<>:"\\|?*]/u.test(part) || Array.from(part).some(c => c.charCodeAt(0) < 32)
   || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)) {
   throw new Error(fromEnglish('Invalid path component: ','无效的路径片段：') + part);
  }
 }
 return parts;
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
