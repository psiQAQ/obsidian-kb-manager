import { segments } from '../fs/segments.ts';
import { tr } from '../i18n.ts';

export function registryDataPath(configDir:string) {
	return configDir + '/plugins/knowledge-base-manager/data.json';
}

export function registryIgnoreFor(configDir:string) {
	return '/' + registryDataPath(configDir).replace(/[\\*?[\]]/gu,'\\$&');
}

export const registryKey = (value:string) => value.normalize('NFC').toLowerCase();
export function sameOrBelow(candidate:string, root:string) {
	return candidate === root || candidate.startsWith(root + '/');
}

export function compareRegistryPaths(a:string,b:string) {
	const right = b[Symbol.iterator]();
	for (const symbol of a) {
		const next = right.next();
		if (next.done) return 1;
		if (symbol !== next.value) return symbol.codePointAt(0)! - next.value.codePointAt(0)!;
	}
	return right.next().done ? 0 : -1;
}

export function validateRegistryPath(relative:string, configDir:string) {
	segments(relative);
	const location = registryKey(relative);
	const reserved = registryKey(configDir);
	if (reserved && (sameOrBelow(location,reserved) || sameOrBelow(reserved,location))) {
		throw new Error(tr('登记位置与 Vault 配置重叠','Library path overlaps the Vault configuration') + ' · ' + relative);
	}
	return relative;
}

function checkedPaths(value:unknown, configDir:string): string[] {
	if (!Array.isArray(value)) throw new Error(tr('知识库清单必须是相对路径数组','The library registry must be an array of relative paths'));
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') throw new Error(tr('知识库清单项必须是相对路径','Each library registry entry must be a relative path'));
		const location = validateRegistryPath(item,configDir);
		const key = registryKey(location);
		if (seen.has(key)) throw new Error(tr('知识库清单中有重复路径','Duplicate path in the library registry') + ' · ' + location);
		seen.add(key);
		paths.push(location);
	}
	return paths.sort(compareRegistryPaths);
}

export function parseRegistry(raw:string, configDir:string) {
	return checkedPaths(JSON.parse(raw) as unknown,configDir);
}

export function serializeRegistry(paths:readonly string[], configDir:string) {
	return JSON.stringify(checkedPaths(paths,configDir),null,2) + '\n';
}

export interface RegistryChange { add?:readonly string[]; remove?:readonly string[] }
export function amendRegistry(paths:readonly string[], change:RegistryChange, configDir:string) {
	const next = new Map(checkedPaths(paths,configDir).map(location => [registryKey(location),location]));
	for (const location of change.remove ?? []) next.delete(registryKey(validateRegistryPath(location,configDir)));
	for (const location of change.add ?? []) {
		const key = registryKey(validateRegistryPath(location,configDir));
		const current = next.get(key);
		if (current && current !== location) throw new Error(tr('登记路径名称冲突','Conflicting registry path spelling') + ' · ' + current);
		next.set(key,location);
	}
	return checkedPaths([...next.values()],configDir);
}

export function withIgnoreRule(raw:string|null, rule:string) {
	const text = raw ?? '';
	const newline = text.match(/\r?\n/u)?.[0] ?? '\n';
	const lines = text.replace(/^\uFEFF/u,'').split(/\r?\n/u);
	const ruleAt = lines.lastIndexOf(rule);
	if (ruleAt !== -1 && !lines.slice(ruleAt + 1).some(line => line.startsWith('!'))) return text;
	return text + (text && !text.endsWith('\n') ? newline : '') + rule + newline;
}
