import {posix} from 'node:path';
import {canvasFileFields} from './canvas-file-fields.ts';
export {canvasFileFields} from './canvas-file-fields.ts';

export function moveVaultPath(file: string, source: string, destination: string): string {
	return file === source || file.startsWith(source + '/') ? destination + file.slice(source.length) : file;
}

// Obsidian supplies the original token and its resolved file. Only replace the
// path inside that token so aliases, fragments, embed dimensions and titles survive.
export function relocateMarkdownReference(
	original: string, fromFile: string, targetFile: string, source: string, destination: string, definition = false,
): string | undefined {
	const from = moveVaultPath(fromFile, source, destination);
	const to = moveVaultPath(targetFile, source, destination);
	if (from === fromFile && to === targetFile) return original;
	const wiki = /^!?\[\[/u.test(original);
	const span = markdownPathSpan(original,definition);
	if (!span) return;
	const [start,end] = span;
	const raw = original.slice(start, end);
	if (!raw || raw.startsWith('#')) return original;
	if (/^[a-z][a-z0-9+.-]*:|^\/\//iu.test(raw)) return;
	let spelled: string;
	try { spelled = decodedPath(raw,wiki); }
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

function decodedPath(raw: string, wiki: boolean) {
	return wiki ? raw : decodeURIComponent(raw.replace(/\\([()\\])/gu, '$1'));
}

export function markdownReferencePath(original: string, definition = false) {
	const span=markdownPathSpan(original,definition);
	if (!span) return undefined;
	try {return decodedPath(original.slice(...span),/^!?\[\[/u.test(original));}
	catch {return undefined;}
}

function markdownPathSpan(original: string, definition: boolean): [number,number] | undefined {
	if (definition) {
		const match=/^ {0,3}\[(?:[^\]\\]|\\.)+\]:[ \t]*(<[^<>\r\n]*>|\S+)/u.exec(original);
		if (!match) return;
		const raw=match[1]!;
		const angle=raw.startsWith('<');
		const start=match[0].length-raw.length+(angle ? 1 : 0);
		const value=angle ? raw.slice(1,-1) : raw;
		const boundary=value.search(/[#?]/u);
		return [start,start+(boundary<0 ? value.length : boundary)];
	}
	const wiki=/^!?\[\[/u.exec(original);
	if (!wiki) return markdownDestination(original);
	if (!original.endsWith(']]')) return;
	const start=wiki[0].length, inner=original.slice(start,-2), boundary=inner.search(/#|\\?\|/u);
	return [start,start+(boundary<0 ? inner.length : boundary)];
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
	return [...new Set(canvasFileFields(text).flatMap(({token})=>token &&
		moveVaultPath(token.target,source,destination)!==token.target ? [token.target] : []))];
}

export function relocateCanvasReferences(text: string, source: string, destination: string, targets?: readonly string[]): string {
	const selected = targets && new Set(targets);
	let result = text;
	for (const {token} of canvasFileFields(text).reverse()) {
		if (!token || selected && !selected.has(token.target)) continue;
		const next = moveVaultPath(token.target, source, destination);
		if (next === token.target) continue;
		result = result.slice(0,token.offset) + JSON.stringify(next) + result.slice(token.offset+token.original.length);
	}
	return result;
}
