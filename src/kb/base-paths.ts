import {isAlias, isCollection, isMap, isScalar, isSeq, LineCounter, parseDocument} from 'yaml';
import type {ParsedNode} from 'yaml';
import {fencedBlocks} from '../diagnostics/fences.ts';

interface BasePathArgument {
	value: string;
	// The complete literal, including the quotes as encoded by the YAML scalar.
	start?: number;
	end?: number;
	replace?: (value: string) => string;
}

export interface BasePathReference {
	kind: 'inFolder' | 'startsWith';
	receiver: 'file' | 'this.file';
	field: string;
	expression: string;
	line: number;
	column: number;
	argument?: BasePathArgument;
}

export interface BasePathFilter {
	field: string;
	expression: string;
	line: number;
	column: number;
	references: BasePathReference[];
}

interface Token {
	text: string;
	start: number;
	end: number;
	value?: string;
}

const folderCall = /\b(?:inFolder|startsWith)\b/u;
const identifier = /[\p{ID_Continue}$]+/uy;
const regexp = /\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\\\]\r\n])*\]|[^/[\\\r\n])+\/[a-z]*/iy;

function tokens(expression: string) {
	const found: Token[] = [];
	for (let start = 0; start < expression.length;) {
		const char = expression[start]!;
		if (/\s/u.test(char)) {start++; continue;}
		let end = start + 1;
		let value: string | undefined;
		if (char === '"' || char === "'") {
			let decoded = '';
			let valid = true;
			while (end < expression.length && expression[end] !== char) {
				const letter = expression[end++]!;
				if (letter === '\\') {
					const escaped = expression[end++];
					if (escaped === char || escaped === '\\') decoded += escaped;
					else valid = false;
				} else {
					if (letter === '\r' || letter === '\n') valid = false;
					decoded += letter;
				}
			}
			if (expression[end] === char) {
				end++;
				if (valid) value = decoded;
			}
		} else {
			const previous = found[found.length - 1]?.text;
			if (char === '/' && (previous === undefined || /^[([,=!<>+*%&|?-]$/u.test(previous))) {
				regexp.lastIndex = start;
				if (regexp.test(expression)) end = regexp.lastIndex;
			} else {
				identifier.lastIndex = start;
				if (identifier.test(expression)) end = identifier.lastIndex;
			}
		}
		found.push({text:expression.slice(start,end),start,end,value});
		start = end;
	}
	return found;
}

function literalSource(source: string, start: number, end: number, style: string | undefined) {
	if (style === 'BLOCK_FOLDED' || style === 'BLOCK_LITERAL') start = source.indexOf('\n', start) + 1 || end;
	const escapeQuote = style === 'QUOTE_DOUBLE' || style === 'QUOTE_SINGLE';
	if (escapeQuote) {start++; end--;}
	let text = '';
	const offsets: number[] = [];
	for (let i = start; i < end; i++) {
		const letter = source[i]!;
		const next = source[i + 1];
		offsets.push(i);
		if (style === 'QUOTE_SINGLE' && letter === "'" && next === "'") {text += letter; i++;}
		else if (style === 'QUOTE_DOUBLE' && letter === '\\') {
			if (next !== '"' && next !== '\\' && next !== '/') return undefined;
			text += next;
			i++;
		} else text += letter;
	}
	offsets.push(end);
	return {text, offsets};
}

function encodeLiteral(value: string, quote: string, style: string | undefined) {
	const escaped = value.replaceAll('\\', '\\\\').replaceAll(quote, '\\' + quote);
	const literal = quote + escaped + quote;
	if (style === 'QUOTE_SINGLE') return literal.replaceAll("'", "''");
	if (style === 'QUOTE_DOUBLE') return JSON.stringify(literal).slice(1,-1);
	return literal;
}

function inspectExpression(source: string, expression: string, field: string, offset: number, lineCounter: LineCounter,
	start: number, end: number, style: string | undefined, aliased: boolean, readOnly: boolean): BasePathFilter {
	const position = (at: number) => {
		const {line, col:column} = lineCounter.linePos(offset + at);
		return {line,column};
	};
	const references: BasePathReference[] = [];
	const filter = {field,expression,...position(start),references};
	if (!folderCall.test(expression)) return filter;
	const lexemes = tokens(expression);
	const literal = aliased ? undefined : literalSource(source,start,end,style);
	const spelling = literal && (literal.text === expression ? lexemes : tokens(literal.text));
	// YAML may fold or indent whitespace around tokens. Match the entire token
	// sequence before using source offsets to avoid editing the wrong literal.
	const mapped = spelling?.length === lexemes.length && spelling.every((token,index) => token.text === lexemes[index]?.text)
		? spelling : undefined;
	for (let i = 0; i < lexemes.length; i++) {
		const token = lexemes[i]!;
		if (lexemes[i - 1]?.text === '.') continue;
		const receiver = token.text === 'this' && lexemes[i + 1]?.text === '.' && lexemes[i + 2]?.text === 'file' ? 'this.file'
			: token.text === 'file' ? 'file' : undefined;
		if (!receiver) continue;
		const member = i + (receiver === 'file' ? 1 : 3);
		if (lexemes[member]?.text !== '.') continue;
		let opening = member + 2;
		let kind: BasePathReference['kind'];
		if (lexemes[member + 1]?.text === 'inFolder') kind = 'inFolder';
		else if (lexemes[member + 1]?.text === 'path' && lexemes[opening]?.text === '.' && lexemes[opening + 1]?.text === 'startsWith') {
			kind = 'startsWith';
			opening += 2;
		} else continue;
		if (lexemes[opening]?.text !== '(') continue;
		const first = lexemes[opening + 1];
		const at = mapped?.[i]?.start;
		const reference: BasePathReference = {kind,receiver,expression,field,...position(at === undefined ? start : literal!.offsets[at]!)};
		if (first?.value !== undefined && lexemes[opening + 2]?.text === ')') {
			reference.argument = {value:first.value};
			const raw = mapped?.[opening + 1];
			if (raw && literal && !readOnly) {
				reference.argument.start = offset + literal.offsets[raw.start]!;
				reference.argument.end = offset + literal.offsets[raw.end]!;
				reference.argument.replace = value => encodeLiteral(value,first.text[0]!,style);
			}
		}
		references.push(reference);
	}
	return filter;
}

function scanYaml(source: string, offset: number, lineCounter: LineCounter) {
	const document = parseDocument(source);
	const filters: BasePathFilter[] = [];
	if (document.errors.length || !isMap(document.contents)) return filters;
	const anchored = (node: unknown) => (isScalar(node) || isCollection(node)) && !!node.anchor;
	function visit(node: unknown, field: string, shared: boolean, depth = 0) {
		if (depth >= 32) return;
		const alias = isAlias(node) ? node : undefined;
		const actual = alias ? alias.resolve(document) : node;
		const readOnly = shared || !!alias || anchored(actual);
		if (isScalar(actual) && typeof actual.value === 'string') {
			const range = (alias ?? actual).range;
			if (!range || !actual.value.trim()) return;
			filters.push(inspectExpression(source,actual.value,field,offset,lineCounter,range[0],range[1],actual.type,!!alias,readOnly));
		} else if (!alias && isMap<unknown, ParsedNode>(actual) && actual.items.length === 1) {
			const {key,value} = actual.items[0]!;
			if (!isScalar(key) || !['and','or','not'].includes(String(key.value)) || !isSeq(value)) return;
			value.items.forEach((item,index) => visit(item,`${field}.${String(key.value)}[${index}]`,readOnly || anchored(value),depth + 1));
		}
	}
	const shared = anchored(document.contents);
	visit(document.get('filters',true),'filters',shared);
	const views = document.get('views',true);
	if (isSeq(views)) views.items.forEach((view,index) => {
		if (isMap(view)) visit(view.get('filters',true),`views[${index}].filters`,shared || anchored(views) || anchored(view));
	});
	return filters;
}

export function scanBasePathFilters(source: string, extension: 'base' | 'md'): BasePathFilter[] {
	const lineCounter = new LineCounter();
	lineCounter.addNewLine(0);
	for (const match of source.matchAll(/\n/gu)) lineCounter.addNewLine(match.index + 1);
	if (extension === 'base') return scanYaml(source,0,lineCounter);
	let bodyStart = 0;
	const header = /^\uFEFF?---[ \t]*(?:\r?\n|$)/u.exec(source);
	if (header) {
		const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(source.slice(header[0].length));
		if (!closing) return [];
		bodyStart = header[0].length + closing.index + closing[0].length;
	}
	return fencedBlocks(source.slice(bodyStart),true).flatMap(({language,sourceStart,sourceEnd}) => language === 'base'
		? scanYaml(source.slice(bodyStart + sourceStart,bodyStart + sourceEnd),bodyStart + sourceStart,lineCounter) : []);
}

export function scanBasePaths(source: string, extension: 'base' | 'md'): BasePathReference[] {
	return scanBasePathFilters(source,extension).flatMap(filter => filter.references);
}
