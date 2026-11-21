import { fromEnglish } from '../i18n.ts';

// Used by the standalone CLI and to exclude settings imported from other vaults.
export const defaultConfigDir = '.obsidian';

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
