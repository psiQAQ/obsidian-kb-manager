import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node } from 'yaml';
import { segments } from '../fs/segments.ts';
import { tr } from '../i18n.ts';

const rootToken = '__KB_ROOT__';
type Skeleton = Record<string, string>;

export function validateKepanoRoot(root: string) {
	segments(root);
	if (/[#^[\]]/u.test(root)) {
		throw new Error(tr('Kepano 链接路径不能含 #、^、[、]。', 'Kepano link paths cannot contain #, ^, [ or ].'));
	}
}

export function renderKepano(skeleton: Skeleton, root: string): Skeleton {
	validateKepanoRoot(root);
	return Object.fromEntries(Object.entries(skeleton).map(([name, source]) => [name, source.split(rootToken).join(root)]));
}

interface Edit { start: number; end: number; old: string; value: string; role: string; replacement: string }
interface Rebinding { content: string; edits: Edit[]; manual: string[] }

function markdownParts(text: string) {
	const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(text);
	if (match?.index !== 0) return { yaml: '', yamlOffset: 0, body: text, bodyOffset: 0 };
	return { yaml: match[1]!, yamlOffset: text.indexOf('\n') + 1, body: text.slice(match[0].length), bodyOffset: match[0].length };
}

// These are the supplied template's exact body lines. A user-edited line,
// a duplicate or a copy in a code fence is never a safe relocation target.
function bodyLines(text: string, offset: number) {
	const lines = new Map<string, number[]>();
	let fence: string | undefined;
	for (const match of text.matchAll(/^[^\r\n]+/gmu)) {
		const line = match[0];
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence) {
			if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
		} else if (marker) {
			fence = marker[1];
		} else {
			const positions = lines.get(line) ?? [];
			positions.push(offset + match.index);
			lines.set(line, positions);
		}
	}
	return lines;
}

/** Only the declared YAML fields and original Markdown lines of bundled files may be rebound. */
export function rebindKepano(name: string, source: string, previous: string, destination: string, skeleton: Skeleton): Rebinding {
	return rebind(name, source, destination, skeleton, previous);
}

export function bindSharedKepanoPage(name: string, source: string, destination: string, skeleton: Skeleton): string {
	return rebind('Templates/' + name, source, destination, skeleton, undefined).content;
}

function rebind(name: string, source: string, destination: string, skeleton: Skeleton, previous: string | undefined): Rebinding {
	const result: Rebinding = { content: source, edits: [], manual: [] };
	if (!Object.prototype.hasOwnProperty.call(skeleton, name) || !skeleton[name]?.includes(rootToken)) return result;
	if (previous !== undefined) validateKepanoRoot(previous);
	validateKepanoRoot(destination);
	const template = skeleton[name];
	const oldValue = (value: string) => previous === undefined
		? value.replaceAll(rootToken + '/', '')
		: value.split(rootToken).join(previous);
	const newValue = (value: string) => value.split(rootToken).join(destination);
	const review = (role: string) => result.manual.push(name + ' · ' + role);
	const parts = (value: string) => name.endsWith('.base') ? { yaml: value, yamlOffset: 0, body: '', bodyOffset: 0 } : markdownParts(value);
	const expected = parts(template), current = parts(source);
	if (expected.yaml.includes(rootToken)) {
		const declared = parseDocument(expected.yaml);
		const actual = parseDocument(current.yaml);
		if (declared.errors.length || actual.errors.length) {
			review(tr('无法解析 YAML', 'Could not parse YAML'));
			return result;
		}
		function inspect(field: Node | null, observed: unknown, role: string) {
			if (isMap(field)) {
				for (const { key, value } of field.items) {
					if (!isScalar(key) || typeof key.value !== 'string') continue;
					const child = isMap(observed) ? observed.get(key.value, true) : undefined;
					inspect(value as Node | null, child, role ? role + '.' + key.value : key.value);
				}
			} else if (isSeq(field)) {
				for (const [index, child] of field.items.entries()) {
					const items = isSeq(observed) ? observed.items : [];
					let observedChild: unknown = items[index];
					if (isScalar(child) && typeof child.value === 'string' && child.value.includes(rootToken)) {
						const old = oldValue(child.value), next = newValue(child.value);
						const hits = items.filter(item => isScalar(item) && (item.value === old || item.value === next));
						observedChild = hits.length === 1 ? hits[0] : undefined;
					} else if (role === 'views' && isMap(child)) {
						const view = child.get('name');
						const hits = items.filter(item => isMap(item) && item.get('name') === view);
						observedChild = hits.length === 1 ? hits[0] : undefined;
					}
					inspect(child as Node | null, observedChild, role + '[' + index + ']');
				}
			} else if (isScalar(field) && typeof field.value === 'string' && field.value.includes(rootToken)) {
				const old = oldValue(field.value), value = newValue(field.value);
				if (isScalar(observed) && observed.value === value) return;
				if (!isScalar(observed) || observed.value !== old || !observed.range) { review(role); return; }
				const original = field.range ? expected.yaml.slice(field.range[0], field.range[1]) : '';
				const encoded = current.yaml.slice(observed.range[0], observed.range[1]);
				const replacement = encoded === oldValue(original) ? newValue(original) : JSON.stringify(value);
				result.edits.push({ start: current.yamlOffset + observed.range[0], end: current.yamlOffset + observed.range[1],
					old, value, replacement, role });
			}
		}
		inspect(declared.contents, actual.contents, '');
	}
	const lines = bodyLines(current.body, current.bodyOffset);
	for (const [line, original] of bodyLines(expected.body, 0)) {
		if (!line.includes(rootToken)) continue;
		const old = oldValue(line), value = newValue(line), role = tr('正文', 'Body');
		const matches = lines.get(old) ?? [];
		const updated = lines.get(value) ?? [];
		if (!matches.length && updated.length === original.length || old === value && matches.length === original.length) continue;
		if (matches.length !== original.length || updated.length > 0) { review(role + ' · ' + old); continue; }
		for (const start of matches) result.edits.push({ start, end: start + old.length, old, value, role, replacement: value });
	}
	for (const edit of [...result.edits].sort((a, b) => b.start - a.start)) {
		result.content = result.content.slice(0, edit.start) + edit.replacement + result.content.slice(edit.end);
	}
	return result;
}
