import {posix as path} from 'node:path';
import {tr} from '../i18n.ts';
import {parseMarkdown, prose, wikiPattern} from '../kb/audit-markdown.ts';
import {baseViewNames} from './base-view.ts';
import {recordChecked} from './checked-items.ts';
import {addReason, reportInventoryCoverage, reportUnreadableNotes} from './coverage.ts';
import {fencedBlocks} from './fences.ts';
import {inspectFootnotes, inspectPdfFragment} from './references.ts';
import type {EvidenceOptions} from './provenance.ts';
import {decode, noteReader, readRelative, relativePath} from './snapshot.ts';
import type {Inventory, NoteRecord} from './snapshot.ts';
import {printable} from './types.ts';
import type {Diagnostic, DiagnosticCheckResult, LinkOccurrence, LinkRequest, LinkResolution} from './types.ts';

const newlineOnly = (text: string) => text.replace(/[^\n]/gu, '');
const local = (value: string) => !/^(?:[A-Za-z][\w+.-]*:|\/\/)/u.test(value);
const attachment = (target: string) => /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp|ico|pdf|mp3|wav|m4a|ogg|flac|mp4|mov|mkv|webm|canvas|base|txt|csv|json|epub|zip)$/iu.test(target);
const image = /\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp|ico)(?:[|#]|$)/iu;
const within = (target: string, folder: string) => !folder || target.startsWith(folder + '/');
const normalize = (value: string) => value.normalize('NFC').toLowerCase();
export const dynamicTarget = (value: string) => /\{\{|<%|__(?:KB_ROOT|WIKI_PATH|NOTES_PATH|WIKI_DIR|TEMPLATES_DIR|CATEGORY_PATH)__/u.test(value);

export function maskLiterals(body: string) {
	return body.replace(/%%[\s\S]*?(?:%%|$)|\$\$[\s\S]*?\$\$|(?<![\\\w$])\$[^$\n]+\$(?![\w$])/gu, newlineOnly)
		.replace(/\{\{[^{}\n]+\}\}|<%[\s\S]*?%>/gu, literal => '{{}}' + newlineOnly(literal));
}

export function staticOccurrences(note: NoteRecord): LinkOccurrence[] {
	const {text, links} = parseMarkdown(maskLiterals(prose(note.body)));
	const lines = text.split('\n');
	const markdown = links.map(({target, line, label}): LinkOccurrence => ({target, line: line + note.lineOffset,
		kind: lines[line - 1]?.includes(`![${label}]`) ? 'embed' : 'link', syntax: 'markdown'}));
	function wiki(text: string, line?: number) {
		return [...text.matchAll(wikiPattern)].filter(match => !/(?:^|[^\\])(?:\\\\)*\\$/u.test(text.slice(0, match.index)))
			.map((match): LinkOccurrence => ({target: match[1]!.split('|')[0]!.replace(/\\$/u, '').trim(),
				kind: match[0].startsWith('!') ? 'embed' : 'link', syntax: 'wiki', line}));
	}
	const metadata = Object.values(note.properties ?? {}).flatMap((value: unknown): unknown[] => Array.isArray(value) ? value : [value]);
	const body = [...markdown, ...lines.flatMap((line, i) => wiki(line, i + 1 + note.lineOffset))].sort((a,b) => (a.line ?? 0) - (b.line ?? 0));
	return [...body,
		...metadata.flatMap(value => typeof value === 'string' ? wiki(value) : [])];
}

export function linkRequest(source: string, occurrence: LinkOccurrence): LinkRequest | undefined {
	const {target: raw, kind, syntax} = occurrence;
	const value = kind === 'embed' && image.test(raw) ? raw.replace(/\\?\|\d+(?:x\d+)?$/iu,'') : raw;
	if (!local(value)) return undefined;
	const hash = value.indexOf('#');
	const target = (hash < 0 ? value : value.slice(0, hash)).trim();
	const fragment = hash < 0 ? undefined : value.slice(hash);
	const file = syntax === 'markdown' ? target.split('?')[0]! : target;
	const decode = syntax === 'markdown' && !occurrence.decoded;
	return {source, target: decode ? decodeURIComponent(file) : file,
		fragment: decode && fragment ? decodeURIComponent(fragment) : fragment, kind, syntax};
}

const pathKey = (value: string) => normalize(value.replace(/\.md$/iu, ''));
const candidateKey = (link: LinkRequest) => !link.canvasPath && relativePath(link.target) ? pathKey(link.target) : '';
const matchesPath = (candidate: string, target: string) => candidate === target || candidate.endsWith('/' + target);

export function linkCandidateIndex(paths: () => Iterable<string>) {
	let byName: Map<string, string[]> | undefined;
	return (link: LinkRequest) => {
		const target = candidateKey(link);
		if (!target) return [];
		if (!byName) {
			const index = new Map<string, string[]>();
			for (const file of paths()) {
				const key = path.basename(pathKey(file));
				const matches = index.get(key) ?? [];
				matches.push(file);
				index.set(key, matches);
			}
			byName = index;
		}
		return (byName.get(path.basename(target)) ?? []).filter(file => matchesPath(pathKey(file), target));
	};
}

export function linkResolver(options: EvidenceOptions, inventory: Inventory, root: string, location: string) {
	const {signal,trace} = options;
	const files = new Set(inventory.files);
	const notes = new Map(inventory.notes.map(note => [note.path, note]));
	const readNote = inventory.mode === 'paths' ? noteReader(root, signal, trace) : undefined;
	const anchors = new Map<string, {headings: Set<string>; blocks: Set<string>} | undefined>();
	const baseViews = new Map<string, Promise<ReadonlySet<string> | undefined>>();
	const vaultPath = (file: string) => location ? `${location}/${file}` : file;
	async function baseAnchor(vaultFile: string, fragment: string): Promise<LinkResolution['anchor']> {
		const file = location ? vaultFile.slice(location.length + 1) : vaultFile;
		if (!within(vaultFile, location) || !files.has(file)) return 'unknown';
		let views = baseViews.get(file);
		if (!views) {
			views = readRelative(root, file, undefined, signal, trace).then(bytes => baseViewNames(decode(bytes))).catch(() => {
				signal?.throwIfAborted();
				return undefined;
			});
			baseViews.set(file, views);
		}
		const names = await views;
		return names ? names.has(fragment.slice(1)) ? 'resolved' : 'missing' : 'unknown';
	}
	async function staticAnchor(file: string, fragment: string): Promise<LinkResolution['anchor']> {
		if (!/\.md$/iu.test(file) || fragment.startsWith('##')) return 'unknown';
		if (!anchors.has(file)) {
			let note = notes.get(file);
			if (!note && readNote) {
				try {note = await readNote(file);}
				catch {signal?.throwIfAborted();}
			}
			if (!note || note.problem?.code === 'unclosed-frontmatter') {
				anchors.set(file,undefined);
				return 'unknown';
			}
			const body = maskLiterals(prose(note.body));
			const headings = new Set<string>();
			for (const m of body.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*$/gmu)) headings.add(normalize(m[1]!.replace(/\s+#+$/u, '').trim()));
			for (const m of body.matchAll(/^ {0,3}(\S[^\n]*)\n {0,3}(?:=+|-+)[ \t]*$/gmu)) headings.add(normalize(m[1]!.trim()));
			anchors.set(file,{headings, blocks:new Set([...body.matchAll(/(?:^|\s)\^([\w-]+)[ \t]*$/gmu)].map(m => m[1]!))});
		}
		const marks = anchors.get(file);
		if (!marks) return 'unknown';
		if (fragment.startsWith('#^')) return marks.blocks.has(fragment.slice(2)) ? 'resolved' : 'missing';
		if (fragment.slice(1).includes('#')) return 'unknown';
		const heading = normalize(fragment.slice(1).trim());
		// Markdown slugs, inline heading markup and escaped forms need the host parser.
		return marks.headings.has(heading) ? 'resolved' : 'unknown';
	}
	async function resolve(file: string, link: LinkRequest): Promise<LinkResolution> {
		signal?.throwIfAborted();
		if (link.fragment?.startsWith('##')) return {status: 'unknown', reason: tr('链接搜索依赖 Obsidian 的全 Vault 索引。','This search link depends on Obsidian’s vault-wide index.')};
		const {target, fragment, canvasPath} = link;
		if (options.resolveLink) {
			try {
				const found = await options.resolveLink(link);
				signal?.throwIfAborted();
				if (found.status === 'resolved') {
					if (!relativePath(found.path)) return {status: 'unknown'};
					if (fragment && /\.base$/iu.test(found.path) && (!found.anchor || found.anchor === 'unknown'))
						return {...found, anchor:await baseAnchor(found.path, fragment)};
				}
				return found;
			} catch {signal?.throwIfAborted(); return {status: 'unknown'};}
		}
		const explicit = !canvasPath && /^\.\.?\//u.test(target);
		let candidate: string;
		if (!target) candidate = file;
		else if (explicit) candidate = path.normalize(path.join(path.dirname(file), target));
		else if (options.vaultRoot && (canvasPath || target.includes('/')) && within(target, location))
			candidate = location ? target.slice(location.length + 1) : target;
		else return {status: 'unknown', reason: tr('离线环境无法确认 Obsidian 选择的目标。','Run this check in Obsidian to confirm where the link resolves.')};
		if (!relativePath(candidate)) return {status: 'unknown'};
		let prefix = candidate;
		while (prefix !== '.') {
			if (inventory.unreadableDirectories.has(prefix)) return {status:'unknown',reason:tr('无法读取链接目标所在的目录。','Could not scan the directory that contains the link target.')};
			if (inventory.excluded.has(prefix)) return {status:'unknown',reason:tr('链接指向检查范围之外的目录或文件。','The link points to a file or folder outside the scan scope.')};
			prefix = path.dirname(prefix);
		}
		if (!canvasPath && !files.has(candidate) && files.has(candidate + '.md')) candidate += '.md';
		if (!files.has(candidate)) return explicit || canvasPath ? {status:'missing'} : {status: 'unknown'};
		const targetPath = vaultPath(candidate);
		const anchor = fragment ? /\.base$/iu.test(candidate) ? await baseAnchor(targetPath, fragment) : await staticAnchor(candidate, fragment) : undefined;
		return {status: 'resolved', path:targetPath, anchor};
	}
	const localCandidates = linkCandidateIndex(function* () {for (const file of files) yield vaultPath(file);});
	const unavailableIndex = tr('无法读取 Obsidian 的同名候选。','Could not read same-name candidates from Obsidian.');
	async function candidates(check: DiagnosticCheckResult, link: LinkRequest, found: LinkResolution) {
		const target = candidateKey(link);
		if (!target) return [];
		const candidates = new Set(localCandidates(link));
		if (found.status === 'resolved' && found.path) candidates.add(found.path);
		if (!check.reason?.includes(unavailableIndex)) {
			try {
				const host = await options.linkCandidates?.(link) ?? [];
				signal?.throwIfAborted();
				if ('paths' in host) {
					if (host.missingLibraries.length && addReason(check, tr('已跳过不存在的登记目录','Skipped missing registered folders') + ' · ' + host.missingLibraries.join(', ')))
						check.coverage.skipped += host.missingLibraries.length;
					if (host.unavailableLibraries.length && addReason(check, tr('无法从 Obsidian 索引核实登记目录的候选','Could not verify candidates for registered folders in Obsidian’s index') + ' · ' + host.unavailableLibraries.join(', ')))
						check.coverage.unknown += host.unavailableLibraries.length;
				}
				for (const path of 'paths' in host ? host.paths : host) candidates.add(path);
			} catch {
				signal?.throwIfAborted();
				if (addReason(check, unavailableIndex)) check.coverage.unknown++;
			}
		}
		return [...candidates].filter(candidate => relativePath(candidate) && matchesPath(pathKey(candidate), target)).sort().slice(0, 20);
	}
	const registered = options.registeredPaths?.filter(other => relativePath(other) && other !== location).sort((a,b) => b.length - a.length);
	function outsideTarget(found: LinkResolution) {
		const target = found.path;
		if (found.status !== 'resolved' || !target || within(target, location)) return undefined;
		const library = registered?.find(other => within(target, other));
		return {target, library, evidence: [target, library && `${tr('所属库','Owning library')} ${library}`].filter(Boolean).join(' · ')};
	}
	async function inspectPortability(check: DiagnosticCheckResult, position: Pick<Diagnostic,'line'> & {file:string},
		link: LinkRequest, found: LinkResolution, details?: string) {
		if (found.status === 'unknown') check.coverage.unknown++;
		const matches = await candidates(check, link, found);
		const matching = matches.length > 1 && `${tr('同名候选','Same-name candidates')} ${matches.join(tr('、',', '))}`;
		const cross = outsideTarget(found);
		if (found.status !== 'unknown') {
			const subject = [details, link.target + (link.fragment ?? '') || position.file].filter(Boolean).join(' · ');
			const outcome = found.status === 'missing' ? tr('目标文件不存在。','The target file is missing.') :
				cross ? tr('依赖库外目标','Depends on a file outside this library') : tr('目标在库内','Target is inside this library');
			recordChecked(check,position.file,subject,[outcome,found.path,matching].filter(Boolean).join(' · '),position.line);
		}
		if (cross) {
			check.diagnostics.push({...position, evidence:[cross.evidence, details, matching].filter(Boolean).join(' · '),
				severity: 'warning', code: 'external-library-dependency', message: cross.library
					? tr('单独移动或克隆本库时需要目标所属库。','Keep the target library available when moving or cloning this library on its own.')
					: tr('单独移动或克隆本库时需要外部目标文件。','Keep the external target file available when moving or cloning this library on its own.')});
		} else if (matching) {
			check.diagnostics.push({...position,severity:'info',code:'same-name-candidates',
				evidence:[found.path && `${tr('实际目标','Resolved target')} ${found.path}`, details, matching].filter(Boolean).join(' · '),
				message:tr('链接存在多个同名候选。','Several files share this link name. Use the target path to disambiguate.')});
		}
	}
	return {resolve, vaultPath, outsideTarget, candidates, inspectPortability};
}

export function missingLink(target: string, kind: LinkRequest['kind']) {
	if (attachment(target)) return {severity:'error', code:'missing-attachment', message:tr('链接或嵌入的附件不存在。','The linked or embedded attachment is missing. Restore it or update the link.')} as const;
	if (kind === 'embed' || target.includes('/') || /\.md$/iu.test(target))
		return {severity:'error', code:'missing-link-target', message:tr('显式链接或嵌入的目标文件不存在。','The explicit link or embed points to a missing file. Check its path.')} as const;
	return {severity:'info', code:'uncreated-note', message:tr('链接指向尚未创建的笔记。','The link points to a note that has not been created yet.')} as const;
}

function reasonForUnknown(check: DiagnosticCheckResult) {
	if (check.coverage.unknown)
		addReason(check, tr('部分结果需要 Obsidian 索引、受支持的链接语法或可读文件才能确认。','Some results need the Obsidian index, supported link syntax, or readable files to be verified.'));
}

export async function inspectLinks(options: EvidenceOptions, inventory: Inventory, root: string, location: string,
	checks: {links?: DiagnosticCheckResult; anchors?: DiagnosticCheckResult; portability?: DiagnosticCheckResult}) {
	const {links, anchors, portability} = checks;
	const checkpoint = diagnosticCheckpoint(options.signal);
	const all = [links, anchors, portability].filter((item): item is DiagnosticCheckResult => !!item);
	const {resolve, vaultPath, outsideTarget, inspectPortability} = linkResolver(options, inventory, root, location);
	for (const check of all) {
		reportInventoryCoverage(check, inventory);
		reportUnreadableNotes(check, inventory);
	}
	for (const note of inventory.notes) {
		const pause = checkpoint?.();
		if (pause) await pause;
		const footnotes = links ?? anchors;
		if (footnotes && (note.body.includes('[^') || note.body.includes('^[')))
			inspectFootnotes(footnotes,maskLiterals(prose(note.body)),note.path,note.lineOffset);
		const dynamic = fencedBlocks(note.body).filter(block => /^(?:base|dataview(?:js)?|tasks|meta-bind(?:-js-view)?|js quickadd)$/u.test(block.language));
		if (dynamic.length) for (const check of all) {
			check.coverage.skipped += dynamic.length;
			const message = tr('查询、公式与自动化代码块的生成内容不参与链接检查。','The link check skips content generated by queries, formulas, and automation blocks.');
			addReason(check, message);
			for (const block of dynamic) check.diagnostics.push({severity:'info', code:'dynamic-block-skipped',
				file:note.path, line:block.line + note.lineOffset, evidence:block.language, message});
		}
		const source = vaultPath(note.path);
		let native: LinkOccurrence[] | undefined;
		if (options.collectLinks) {
			try {native = await options.collectLinks(source);} catch {/* Treat a cache failure as partial. */}
			options.signal?.throwIfAborted();
			if (native === undefined) for (const check of all) check.coverage.unknown++;
		}
		if (note.problem) for (const check of all) {
			check.coverage.unknown++;
			const message = note.problem.code === 'unclosed-frontmatter'
				? tr('未找到 YAML 属性的结束标记，无法完整检查属性和正文中的链接。','Could not verify all links in the frontmatter and body because the frontmatter has no closing delimiter.')
				: tr('YAML 属性无效，无法完整检查属性中的链接。','Could not verify all links in the frontmatter because it contains invalid YAML.');
			check.diagnostics.push({severity:'info', code:'unverified-property-links', file:note.path, line:note.problem.line, message});
			addReason(check, tr('部分 Markdown 属性中的链接未能验证。','Some links in Markdown frontmatter could not be verified.'));
		}
		for (const occurrence of native ?? staticOccurrences(note)) {
			const pause = checkpoint?.();
			if (pause) await pause;
			const line = occurrence.line;
			if (native && line !== undefined && dynamic.some(block => line >= block.line + note.lineOffset && line <= block.endLine + note.lineOffset))
				continue;
			let requestValue: LinkRequest | undefined;
			try {requestValue = linkRequest(source, occurrence);} catch {
				if (links) {
					recordChecked(links,note.path,occurrence.target,tr('URL 转义无效。','Invalid URL encoding.'),line);
					links.diagnostics.push({severity: 'error', code: 'invalid-link-encoding', file: note.path, line: occurrence.line, message: tr('链接包含无效的 URL 转义。','The link contains invalid URL encoding. Check any percent escapes.')});
				}
				continue;
			}
			if (!requestValue) {if (links) links.coverage.skipped++; continue;}
			const link = requestValue;
			const position = {file: note.path, line: occurrence.line};
			if (dynamicTarget(link.target) || dynamicTarget(link.fragment ?? '')) {
				for (const check of all) {
					if (check === anchors && !link.fragment) continue;
					check.coverage.skipped++;
					check.diagnostics.push({...position, severity:'info',code:'template-link-deferred',message:tr('模板链接待填入变量后检查。','Check this template link after its variables are filled in.')});
				}
				continue;
			}
			const found = await resolve(note.path, link);
			const evidence = found.path ?? (relativePath(link.target) ? link.target : undefined);
			const cross = outsideTarget(found);
			if (links) {
				if (found.status === 'unknown') links.coverage.unknown++;
				else recordChecked(links,note.path,occurrence.target || note.path,found.status === 'missing'
					? tr('目标文件不存在。','The target file is missing.')
					: `${tr('目标文件','Target file')} · ${found.path}`,line);
				if (found.status === 'missing') links.diagnostics.push({...position,evidence,...missingLink(link.target,link.kind)});
				else if (cross) links.diagnostics.push({...position, evidence, severity: 'info', code: 'cross-library-link', message: tr('链接解析到当前知识库之外的 Vault 文件。','The link resolves to a vault file outside this library.')});
				else if (found.status === 'unknown') links.diagnostics.push({...position,evidence,severity:'info',code:'unverified-link',
					message:printable(found.reason,512) ? found.reason : options.resolveLink ?
						tr('目前无法确认 Obsidian 链接目标。','Obsidian could not resolve this link yet.') :
						tr('离线环境无法确认 Obsidian 的实际链接目标。','Run this check in Obsidian to confirm where the link resolves.')});
			}
			const media = anchors ?? links;
			const pdf = media && inspectPdfFragment(media,link,found,{...position,evidence});
			if (anchors && link.fragment && !pdf) {
				if (found.status === 'missing') anchors.coverage.skipped++;
				else if (!found.anchor || found.anchor === 'unknown') {
					anchors.coverage.unknown++;
					anchors.diagnostics.push({...position,evidence,severity:'info',code:'unverified-anchor',message:tr('未能确认链接指定的标题、块或 Base 视图。','Could not verify the heading, block, or Base view referenced by the link.')});
				}
				else {
					recordChecked(anchors,note.path,occurrence.target,found.anchor === 'missing'
						? tr('目标缺少引用的标题、块或视图。','The target is missing the referenced heading, block, or view.')
						: tr('找到引用的标题、块或视图。','The referenced heading, block, or view was found.'),line);
					if (found.anchor === 'missing') {
						const base = /\.base$/iu.test(found.path ?? link.target);
						anchors.diagnostics.push({...position,evidence,severity:'error',code:base ? 'missing-base-view' : 'missing-anchor',
							message:base ? tr('目标 Base 中没有指定的视图。','The Base does not contain the named view. Check its name in the embed.') :
								tr('目标文件不存在指定的标题或块。','The target file is missing the referenced heading or block. Check the link fragment.')});
					}
				}
			}
			if (portability) await inspectPortability(portability, position, link, found);
		}
	}
	for (const check of all) reasonForUnknown(check);
}
import {diagnosticCheckpoint} from './checkpoint.ts';
