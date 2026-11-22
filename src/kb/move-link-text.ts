import {posix} from 'node:path';
import {isMap, isScalar, isSeq, parseDocument} from 'yaml';

export function moveVaultPath(file: string, source: string, destination: string): string {
	return file === source || file.startsWith(source + '/') ? destination + file.slice(source.length) : file;
}

// Obsidian supplies the original token and its resolved file. Only replace the
// path inside that token so aliases, fragments, embed dimensions and titles survive.
export function relocateMarkdownReference(
	original: string, fromFile: string, targetFile: string, source: string, destination: string,
): string | undefined {
	const from = moveVaultPath(fromFile, source, destination);
	const to = moveVaultPath(targetFile, source, destination);
	if (from === fromFile && to === targetFile) return original;
	const wiki = /^!?\[\[/u.exec(original);
	let start: number;
	let end: number;
	if (wiki) {
		if (!original.endsWith(']]')) return;
		start = wiki[0].length;
		const inner = original.slice(start, -2);
		const boundary = inner.search(/#|\\?\|/u);
		end = start + (boundary < 0 ? inner.length : boundary);
	} else {
		const span = markdownDestination(original);
		if (!span) return;
		[start, end] = span;
	}
	const raw = original.slice(start, end);
	if (!raw || raw.startsWith('#')) return original;
	if (/^[a-z][a-z0-9+.-]*:|^\/\//iu.test(raw)) return;
	let spelled: string;
	try { spelled = wiki ? raw : decodeURIComponent(raw.replace(/\\([()\\])/gu, '$1')); }
	catch { return; }
	const omitExtension = to.endsWith('.md') && !spelled.toLowerCase().endsWith('.md');
	const pathTo = omitExtension ? to.slice(0,-3) : to;
	const absolute = spelled.startsWith('/');
	const relative = /^\.\.?\//u.test(spelled);
	let path = pathTo;
	if (absolute) path = '/' + path;
	else if (!wiki || relative) {
		path = posix.relative(posix.dirname(from), pathTo);
		if (!path) path = posix.basename(pathTo);
		if (!path.startsWith('../') && relative && (wiki || spelled.startsWith('./'))) path = './' + path;
	} else if (spelled === posix.basename(pathTo) && posix.dirname(from) === posix.dirname(to)) {
		path = spelled;
	}
	if (path === spelled) return original;
	// Some vault filenames have no unambiguous wikilink spelling.
	if (wiki && /[#|[\]^\\]/u.test(path)) return;
	const replacement = wiki ? path : path.split('/').map(part => encodeURIComponent(part)
		.replace(/[()]/gu, letter => letter === '(' ? '%28' : '%29')).join('/');
	return original.slice(0, start) + replacement + original.slice(end);
}

function markdownDestination(token: string): [number, number] | undefined {
	const opening = /^!?\[/u.exec(token);
	if (!opening || !token.endsWith(')')) return;
	let depth = 1, i = opening[0].length;
	for (; i < token.length && depth; i++) {
		if (token[i] === '\\') i++;
		else if (token[i] === '[') depth++;
		else if (token[i] === ']') depth--;
	}
	if (depth || token[i++] !== '(') return;
	while (i < token.length && /\s/u.test(token[i]!)) i++;
	const angle = token[i] === '<';
	const start = angle ? ++i : i;
	for (; i < token.length; i++) {
		const letter = token[i]!;
		if (letter === '#' || letter === '?') return [start, i];
		if (letter === '\\') { i++; continue; }
		if (angle) {
			if (letter === '>') return [start, i];
		} else if (letter === '(') depth++;
		else if (letter === ')') {
			if (depth === 0) return [start, i];
			depth--;
		} else if (/\s/u.test(letter) && !depth) return [start, i];
	}
	return undefined;
}

export function canvasMoveTargets(text: string, source: string, destination: string): string[] {
	const canvas: unknown = JSON.parse(text);
	if (!canvas || typeof canvas !== 'object' || !('nodes' in canvas) || !Array.isArray(canvas.nodes))
		throw new Error('Invalid Canvas nodes');
	const entries: unknown[] = canvas.nodes;
	return [...new Set(entries.flatMap(node => node && typeof node === 'object' && 'type' in node && node.type === 'file' &&
		'file' in node && typeof node.file === 'string' && moveVaultPath(node.file,source,destination) !== node.file ? [node.file] : []))];
}

export function relocateCanvasReferences(text: string, source: string, destination: string, targets?: readonly string[]): string {
	// YAML's syntax tree supplies the exact ranges of JSON string values,
	// including escaped JSON, without reserializing the canvas.
	const affected = targets ?? canvasMoveTargets(text,source,destination);
	if (!affected.length) return text;
	const selected = new Set(affected);
	const doc = parseDocument(text, {schema:'json'});
	if (doc.errors.length) throw new Error('Ambiguous Canvas document');
	const nodes = doc.get('nodes', true);
	if (!isSeq(nodes)) throw new Error('Invalid Canvas nodes');
	let result = text;
	for (const node of [...nodes.items].reverse()) {
		if (!isMap(node) || node.get('type') !== 'file') continue;
		const file = node.get('file', true);
		if (!isScalar(file) || typeof file.value !== 'string' || !file.range || !selected.has(file.value)) continue;
		const next = moveVaultPath(file.value, source, destination);
		if (next === file.value) continue;
		const [start, end] = file.range;
		result = result.slice(0,start) + JSON.stringify(next) + result.slice(end);
	}
	return result;
}
