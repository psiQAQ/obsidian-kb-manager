import {parse} from 'yaml';
import {tr} from '../i18n.ts';
import {prose} from '../kb/audit-markdown.ts';
import {bindingEvidence} from './binding-evidence.ts';
import {diagnosticCheckpoint} from './checkpoint.ts';
import {reportInventoryCoverage, reportUnreadableNotes} from './coverage.ts';
import {fencedBlocks} from './fences.ts';
import {dynamicTarget, linkRequest, linkResolver, maskLiterals, staticOccurrences} from './links.ts';
import {footnoteEvidence} from './references.ts';
import type {EvidenceOptions} from './provenance.ts';
import {decode, readRelative, relativePath} from './snapshot.ts';
import type {Inventory, TemplateSnapshot, libraryLocation, manifestSnapshot} from './snapshot.ts';
import {isRecord, result} from './types.ts';
import type {DiagnosticCheckResult, LinkOccurrence, LinkRequest} from './types.ts';

type Manifest = Awaited<ReturnType<typeof manifestSnapshot>>;
type Location = Awaited<ReturnType<typeof libraryLocation>>;

async function* readStructured(root: string, inventory: Inventory, extension: string, {signal,trace}: EvidenceOptions) {
	let remaining = 24 * 1024 * 1024;
	for (const file of inventory.files) {
		if (!file.toLowerCase().endsWith(extension)) continue;
		let text: string | undefined;
		try {
			const bytes = await readRelative(root,file,Math.min(remaining,2 * 1024 * 1024),signal,trace);
			remaining -= bytes.length;
			text = decode(bytes);
		} catch {signal?.throwIfAborted();}
		yield {file,text};
	}
}

function baseData(text: string) {
	try {
		const data: unknown = parse(text);
		// Bridge only plain JSON values. YAML aliases can create cyclic objects.
		return JSON.parse(JSON.stringify(data)) as unknown;
	} catch {return undefined;}
}

export function commonEvidence(options: EvidenceOptions, location: Location, inventory: Inventory,
	manifest: Manifest, template: TemplateSnapshot, templateDirs: string[], selected: ReadonlySet<string>) {
	const {root, relative, vault, identifiedVault} = location;
	const {signal} = options;
	const checkpoint = diagnosticCheckpoint(signal);
	let resolver: ReturnType<typeof linkResolver> | undefined;
	const getResolver = () => resolver ??= linkResolver({...options,vaultRoot:identifiedVault ? vault : undefined}, inventory, root, relative);

	async function reference(file: string, link: LinkRequest, line?: number) {
		if (dynamicTarget(link.target) || dynamicTarget(link.fragment ?? '')) return {kind:'template' as const, link, line};
		const {resolve,outsideTarget} = getResolver();
		const found = await resolve(file, link);
		return {kind:'local' as const, link, found, line, cross:outsideTarget(found),
			evidence:found.path ?? (relativePath(link.target) ? link.target : undefined)};
	}
	async function occurrence(file: string, item: LinkOccurrence) {
		const pause = checkpoint?.();
		if (pause) await pause;
		let link: LinkRequest | undefined;
		try {link = linkRequest(getResolver().vaultPath(file), item);}
		catch {return {kind:'invalid-encoding' as const, line:item.line};}
		return link ? reference(file, link, item.line) : {kind:'external' as const, line:item.line};
	}
	async function readLinks() {
		const {vaultPath} = getResolver();
		const notes = [];
		for (const note of inventory.notes) {
			const pause = checkpoint?.();
			if (pause) await pause;
			const {path:file, body, lineOffset, problem} = note;
			const dynamic = fencedBlocks(body).filter(block => /^(?:base|dataview(?:js)?|tasks|meta-bind(?:-js-view)?|js quickadd)$/u.test(block.language))
				.map(({language,line,endLine}) => ({language,line:line+lineOffset,endLine:endLine+lineOffset}));
			let native: LinkOccurrence[] | undefined;
			try {native = await options.collectLinks?.(vaultPath(file));} catch {/* Retain static evidence if the cache is unavailable. */}
			const references = [];
			for (const item of native ?? staticOccurrences(note)) {
				const line = item.line;
				if (native && line !== undefined && dynamic.some(block => line >= block.line && line <= block.endLine)) continue;
				references.push(await occurrence(file,item));
			}
			const footnotes = body.includes('[^') || body.includes('^[') ? footnoteEvidence(maskLiterals(prose(body)),lineOffset) : undefined;
			notes.push({file, lineOffset, problem, dynamic, footnotes, references, cacheUnavailable:!!options.collectLinks && native === undefined});
		}
		return notes;
	}
	async function readCanvases() {
		const {vaultPath} = getResolver();
		const canvases = [];
		for await (const {file,text} of readStructured(root,inventory,'.canvas',options)) {
			if (text === undefined) {canvases.push({file, unreadable:true}); continue;}
			let data: unknown;
			try {data = JSON.parse(text);} catch {canvases.push({file, malformed:true}); continue;}
			const references = [];
			if (isRecord(data) && Array.isArray(data.nodes)) for (const node of data.nodes as unknown[]) {
				const pause = checkpoint?.();
				if (pause) await pause;
				if (!isRecord(node)) {references.push([]); continue;}
				if (node.type === 'text' && typeof node.text === 'string') {
					const links = [];
					for (const item of staticOccurrences({path:file,body:node.text,lineOffset:0})) links.push(await occurrence(file,item));
					references.push(links);
					continue;
				}
				const target = node.type === 'file' ? node.file : node.type === 'group' ? node.background : undefined;
				if (!relativePath(target)) {references.push([]); continue;}
				const fragment = node.type === 'file' && typeof node.subpath === 'string' && node.subpath.startsWith('#') ? node.subpath : undefined;
				references.push([await reference(file,{source:vaultPath(file),target,fragment,kind:'embed',syntax:'wiki',canvasPath:true})]);
			}
			canvases.push({file,data,references});
		}
		return canvases;
	}
	let links: ReturnType<typeof readLinks> | undefined;
	let canvases: ReturnType<typeof readCanvases> | undefined;
	const getLinks = () => links ??= readLinks();
	const getCanvases = () => canvases ??= readCanvases();

	return async (check: DiagnosticCheckResult, bundled = false) => {
		const {id} = check;
		if (['links','anchors','portability','properties','bases','canvas'].includes(id)) reportInventoryCoverage(check,inventory);
		if (['links','anchors','portability','properties'].includes(id)) reportUnreadableNotes(check,inventory);
		switch (id) {
		case 'manifest':
			return {result:check, manifest:{parsed:manifest.parsed && {identity:manifest.parsed.identity},paths:manifest.paths,reason:manifest.reason},
				template:{template:template.template && {id:template.template.id,version:template.template.version,entry:template.template.entry},reason:template.reason},
				registration:{registered:options.registered,duplicate:options.duplicate}, inventory:{files:[...inventory.files],
					directories:[...inventory.directories],unreadableDirectories:[...inventory.unreadableDirectories]}};
		case 'properties': return {result:check, templateDirs, notes:inventory.notes.map(({path,problem}) => ({path,problem}))};
		case 'bindings': return {result:check,...await bindingEvidence(options,location,manifest,bundled)};
		case 'bases': {
			const noteCoverage = result({id:check.id,name:check.name});
			reportUnreadableNotes(noteCoverage,inventory);
			const files = [];
			for await (const {file,text} of readStructured(root,inventory,'.base',options)) files.push({file,data:text === undefined ? undefined : baseData(text),unreadable:text === undefined});
			const notes = [];
			for (const {path:file,problem,body,lineOffset} of inventory.notes) {
				const pause = checkpoint?.();
				if (pause) await pause;
				const blocks = fencedBlocks(body).filter(block => block.language === 'base')
					.map(({source,line}) => ({data:baseData(source),line:line+lineOffset}));
				notes.push({file,problem,blocks});
			}
			return {result:check, files, notes, noteCoverage};
		}
		case 'links': case 'anchors':
			return {result:check, notes:await getLinks(), linksSelected:selected.has('links'), anchorsSelected:selected.has('anchors'), desktop:!!options.resolveLink};
		case 'canvas': return {result:check, canvases:await getCanvases(), portabilitySelected:selected.has('portability')};
		case 'portability': {
			const scope = options.linkCandidateScope;
			if (scope) {
				const reason = scope === 'vault' ? tr('同名候选范围为整个 Vault。','Same-name candidates are checked across the vault.') : options.registeredPaths
					? tr('同名候选范围为当前库和已登记库。','Same-name candidates are checked in the current and registered libraries.')
					: tr('知识库登记不可用，同名候选只检查当前库。','The library registry is unavailable. Same-name candidates are checked in the current library.');
				check.reason = check.reason ? reason + ' ' + check.reason : reason;
				if (scope === 'registered' && !options.registeredPaths) check.coverage.unknown++;
			}
			const notes = await getLinks(), canvasFiles = await getCanvases();
			const {candidates} = getResolver();
			const candidateMatches = [];
			const canvasMatches = [];
			for (const note of notes) {
				const matches = [];
				for (const ref of note.references) matches.push(ref.kind === 'local' ? await candidates(check,ref.link,ref.found) : []);
				candidateMatches.push(matches);
			}
			for (const canvas of canvasFiles) {
				const nodes = [];
				for (const references of canvas.references ?? []) {
					const matches = [];
					for (const ref of references) matches.push(ref.kind === 'local' ? await candidates(check,ref.link,ref.found) : []);
					nodes.push(matches);
				}
				canvasMatches.push(nodes);
			}
			return {result:check, notes, canvases:canvasFiles, candidateMatches, canvasMatches, canvasSelected:selected.has('canvas')};
		}
		default: throw new Error('unknown-common-rule');
		}
	};
}
