import { fromEnglish } from '../i18n.ts';
import { segments } from '../fs/segments.ts';

export const identityFile = 'kb-manager.json';
export interface ManagedFile { path: string; fingerprint: string; root?: string; role?: 'overview-bindings' | 'kepano-bindings' }
export interface Identity {
	schemaVersion: 1; id: string; displayName: string; description: string; archived: boolean;
	template: {id: string; version: string}; managed: ManagedFile[]; entry?: string;
}

export function parseIdentity(raw: string): Identity {
	const obj: unknown = JSON.parse(raw);
	if (!obj || typeof obj !== 'object') throw new Error(fromEnglish('Invalid knowledge base identity','知识库身份无效'));
	const value = obj as Partial<Identity>;
	if (value.schemaVersion !== 1) throw new Error(fromEnglish('Unsupported identity schema: ','不支持的身份格式：') + String(value.schemaVersion));
	if (typeof value.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value.id)
		|| typeof value.displayName !== 'string' || !value.displayName.trim() || typeof value.description !== 'string'
		|| typeof value.archived !== 'boolean' || typeof value.template?.id !== 'string' || typeof value.template.version !== 'string'
		|| !Array.isArray(value.managed)) throw new Error(fromEnglish('Invalid identity fields','知识库身份字段无效'));
	if (value.entry !== undefined) segments(value.entry);
	for (const item of value.managed) {
		if (!item || typeof item.path !== 'string' || typeof item.fingerprint !== 'string') throw new Error(fromEnglish('Invalid managed file','受管文件声明无效'));
		segments(item.path);
	}
	return value as Identity;
}
