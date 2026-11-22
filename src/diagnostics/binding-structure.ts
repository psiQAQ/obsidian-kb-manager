import {parse} from 'yaml';
import {tr} from '../i18n.ts';
import {prose} from '../kb/audit-markdown.ts';
import type {ManagedFile} from '../kb/identity-core.ts';
import {rebindSlots} from '../kb/instance-text.ts';
import {fencedBlocks} from './fences.ts';
import {dynamicTarget, linkRequest, staticOccurrences} from './links.ts';
import {isRecord} from './types.ts';
import type {LinkOccurrence, LinkRequest} from './types.ts';

const marker = 'KBMANAGERBINDINGROOTPLACEHOLDER';
export type BindingStatus = 'verified' | 'changed' | 'unknown';
export type CheckBindingLink = (expected: string, link: LinkRequest) => Promise<BindingStatus>;
type StructureStatus = BindingStatus | 'unsupported';
interface StructureCheck {status: StructureStatus; evidence?: string}

function structured(text: string): unknown {
	try {return parse(text,{maxAliasCount:0,logLevel:'silent'}) as unknown;}
	catch {return undefined;}
}

function splitMarkdown(text: string) {
	if (!/^\uFEFF?---[ \t]*\r?\n/u.test(text)) return {yaml:'', body:text};
	const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(text);
	return header?.index === 0 ? {yaml:header[1] ?? '', body:text.slice(header[0].length)} : undefined;
}

function bodyScopes(body: string) {
	const headings: {level: number; value: string}[] = [];
	const sections: string[] = [];
	const occurrences = new Map<string,number>();
	const unique = (key: string) => {
		const index = occurrences.get(key) ?? 0;
		occurrences.set(key,index+1);
		return key + '\0' + index;
	};
	const visible = prose(body.replace(/^\uFEFF/u,'')).replace(/%%[\s\S]*?(?:%%|$)/gu,text => text.replace(/[^\n]/gu,''))
		.replace(/^(?: {4}|\t).*$/gmu,'');
	for (const [index,line] of visible.split('\n').entries()) {
		const name = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/u.exec(line);
		if (name) {
			const level = name[1]!.length;
			while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop();
			headings.push({level,value:unique(JSON.stringify([headings.at(-1)?.value,level,name[2]]))});
		}
		sections[index+1] = headings.at(-1)?.value ?? '';
	}
	const links = new Map<string,LinkOccurrence>();
	for (const link of staticOccurrences({path:'',body:visible,lineOffset:0}))
		links.set(unique(JSON.stringify(['link',sections[link.line ?? 0],link.kind])),link);
	const blocks = new Map<string,string>();
	for (const block of fencedBlocks(body))
		blocks.set(unique(JSON.stringify(['fence',sections[block.line],block.language])),block.source);
	return {links,blocks};
}

function wikiProperty(text: string): LinkOccurrence | undefined {
	const matches = staticOccurrences({path:'',body:'',lineOffset:0,properties:{value:text}});
	return matches.length === 1 ? matches[0] : undefined;
}

function markedSource(binding: ManagedFile, source: string, root: string) {
	if (source.includes(marker)) return undefined;
	if (binding.role === 'template-root' && binding.offsets)
		return rebindSlots(source,binding.offsets,root,marker,binding.path);
	// Older built-in records predate explicit slot offsets. Their root prefix
	// is checked only in a fingerprint-matched source and supported fields.
	if (binding.role === 'kepano-bindings' || binding.path === 'knowledge.base')
		return source.replaceAll(root+'/',marker+'/');
	return undefined;
}

export async function verifyBindingStructure(binding: ManagedFile, baseline: string, actual: string,
	location: string, checkLink: CheckBindingLink): Promise<StructureCheck> {
	if (!binding.root || !/\.(?:md|base)$/iu.test(binding.path)) return {status:'unsupported'};
	let marked: string | undefined;
	try {marked = markedSource(binding,baseline,binding.root);}
	catch {return {status:'unsupported'};}
	const count = (text: string) => text.split(marker).length - 1;
	if (!marked || !count(marked)) return {status:'unsupported'};
	const statuses: Promise<StructureCheck>[] = [];
	let visited = 0;
	const source = location ? location + '/' + binding.path : binding.path;
	const markdown = /\.md$/iu.test(binding.path);
	const visible = (value: string) => Array.from(value.slice(0,160),character => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127 ? ' ' : character;
	}).join('').trim();
	function track(status: StructureStatus | Promise<StructureStatus>, field: string, expected: string, current: unknown) {
		statuses.push(Promise.resolve(status).then(value => ({
			status:value,
			evidence:value === 'changed' ? [visible(field),tr('期望','Expected') + ' ' + visible(expected),
				tr('当前','Current') + ' ' + (typeof current === 'string' && visible(current) || tr('缺失或无效','Missing or invalid'))].join(' · ') : undefined,
		})));
	}
	async function compareLink(expected: LinkOccurrence | undefined, current: LinkOccurrence | undefined): Promise<StructureStatus> {
		if (!expected) return 'unsupported';
		try {
			const original = linkRequest(source,expected);
			if (!original?.target.startsWith(marker+'/')) return 'unsupported';
			if (!current) return 'changed';
			const observed = linkRequest(source,current);
			if (!observed || dynamicTarget(observed.target)) return observed ? 'unknown' : 'changed';
			if (original.kind !== observed.kind || original.fragment !== observed.fragment) return 'changed';
			return await checkLink(original.target.slice(marker.length+1),observed);
		} catch {return 'unknown';}
	}
	function compareNodes(expected: unknown, current: unknown, field = '', namedViews = false, depth = 0) {
		if (depth > 40) return;
		if (typeof expected === 'string' && count(expected)) {
			visited += count(expected);
			const expectedValue = expected.replaceAll(marker,location);
			const status = markdown ? compareLink(wikiProperty(expected),typeof current === 'string' ? wikiProperty(current) : undefined) :
				expectedValue === current ? 'verified' : 'changed';
			track(status,field,expectedValue,current);
		} else if (isRecord(expected)) {
			for (const [key,value] of Object.entries(expected)) {
				const child = isRecord(current) && Object.prototype.hasOwnProperty.call(current,key) ? current[key] : undefined;
				compareNodes(value,child,field ? field+'.'+key : key,!depth && key === 'views',depth+1);
			}
		} else if (Array.isArray(expected)) {
			for (const [index,value] of expected.entries()) {
				const candidates: unknown[] = Array.isArray(current) ? current : [];
				const name = namedViews && isRecord(value) && typeof value.name === 'string' ? value.name : undefined;
				const matches = name === undefined ? [candidates[index]] : candidates.filter(view => isRecord(view) && view.name === name);
				compareNodes(value,matches.length === 1 ? matches[0] : undefined,
					field+'['+(name === undefined ? index : JSON.stringify(name))+']',false,depth+1);
			}
		}
	}
	if (markdown) {
		const expected = splitMarkdown(marked), current = splitMarkdown(actual);
		if (!expected) return {status:'unsupported'};
		if (!current) return {status:'changed',evidence:tr('正文或 YAML 属性无法读取','Markdown body or frontmatter is unavailable')};
		if (count(expected.yaml)) {
			const from = structured(expected.yaml), to = structured(current.yaml);
			if (!isRecord(from)) return {status:'unsupported'};
			if (to === undefined) return {status:'changed',evidence:tr('YAML 属性无法解析','Frontmatter cannot be parsed')};
			compareNodes(from,to);
		}
		if (count(expected.body)) {
			const from = bodyScopes(expected.body), to = bodyScopes(current.body);
			for (const [key,value] of from.links) {
				if (!count(value.target)) continue;
				visited += count(value.target);
				const link = to.links.get(key);
				track(compareLink(value,link),tr('正文第 ','Body line ') + ((link ?? value).line ?? 1),
					value.target.replaceAll(marker,location),link?.target);
			}
			for (const [key,value] of from.blocks) {
				if (!count(value)) continue;
				visited += count(value);
				statuses.push(Promise.resolve({status:value.replaceAll(marker,location) === to.blocks.get(key) ? 'verified' : 'unknown'}));
			}
		}
	} else {
		const expected = structured(marked), current = structured(actual);
		if (!isRecord(expected)) return {status:'unsupported'};
		if (!isRecord(current)) return {status:'changed',evidence:tr('Base YAML 无法解析','Base YAML cannot be parsed')};
		compareNodes(expected,current);
	}
	const findings = await Promise.all(statuses);
	const firstChange = findings.find(({status}) => status === 'changed');
	if (firstChange) return firstChange;
	if (findings.some(({status}) => status === 'unknown')) return {status:'unknown'};
	return {status:visited !== count(marked) || findings.some(({status}) => status === 'unsupported') || !findings.length ? 'unsupported' : 'verified'};
}
