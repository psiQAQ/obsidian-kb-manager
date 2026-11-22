import {parse} from 'yaml';
import {tr} from '../i18n.ts';
import {addReason, reportInventoryCoverage, reportUnreadableNotes} from './coverage.ts';
import {fencedBlocks} from './fences.ts';
import {dynamicTarget, linkRequest, linkResolver, missingLink, staticOccurrences} from './links.ts';
import {inspectPdfFragment} from './references.ts';
import type {EvidenceOptions, InputTrace} from './provenance.ts';
import {decode, readRelative, relativePath} from './snapshot.ts';
import type {Inventory, TemplateSnapshot, manifestSnapshot} from './snapshot.ts';
import {isRecord, printable} from './types.ts';
import type {Diagnostic, DiagnosticCheckResult, DiagnosticOptions, LinkRequest} from './types.ts';

type Manifest = Awaited<ReturnType<typeof manifestSnapshot>>;

export function inspectManifest(check: DiagnosticCheckResult, options: DiagnosticOptions, manifest: Manifest, template: TemplateSnapshot, inventory: Inventory) {
	const {parsed} = manifest;
	check.coverage.checked++;
	if (!parsed) check.diagnostics.push({severity: 'error', code: 'invalid-manifest', file: 'kb.toml', message: manifest.reason});
	else if (!parsed.identity) check.diagnostics.push({severity: 'warning', code: 'legacy-identity', file: 'kb.toml', message: tr('清单没有受管知识库身份。','The manifest has no managed library identity. Review it before adopting this library.')});
	if (template.reason) {
		check.coverage.checked++;
		check.diagnostics.push({severity: 'error', code: 'invalid-template', file: 'kb-template.json', message: template.reason});
	}
	if (template.template) {
		check.coverage.checked++;
		const identity = parsed?.identity?.template;
		if (identity && identity.id !== 'unknown' && (identity.id !== template.template.id || identity.version !== template.template.version))
			check.diagnostics.push({severity: 'warning', code: 'template-version-drift', file: 'kb-template.json', message: tr('模板声明的 ID 或版本与实例清单不同。','The template ID or version differs from the library manifest. Review both files.')});
	}
	function verifyPath(file: string, candidates: Set<string>, missing: Omit<Diagnostic, 'file'>) {
		if (!candidates.has(file)) {
			const directory = [...inventory.unreadableDirectories].find(dir => file === dir || file.startsWith(dir + '/'));
			if (directory) {
				check.coverage.unknown++;
				const message = tr('无法扫描清单路径所在的目录。','Could not scan the directory that contains the configured path.');
				check.diagnostics.push({severity:'info', code:'manifest-path-unverified', file, evidence:directory, message});
				addReason(check, tr('部分清单路径所在的目录无法遍历。','Some configured paths are in directories that could not be scanned.'));
				return;
			}
			check.diagnostics.push({...missing, file});
		}
		check.coverage.checked++;
	}
	const entry = parsed?.identity?.entry ?? template.template?.entry;
	if (entry) verifyPath(entry, inventory.files, {severity:'error', code:'missing-entry',
		message:tr('清单指定的入口文件不存在。','The configured entry file is missing. Restore it or update its path.')});
	for (const [role, relative] of Object.entries(manifest.paths ?? {})) {
		if (!relativePath(relative) || relative === entry) continue;
		const candidates = ['overview','index','log'].includes(role) ? inventory.files : inventory.directories;
		verifyPath(relative, candidates, {severity:'error', code:'missing-mapping',
			message:tr('清单映射的文件或目录不存在。','The mapped file or folder is missing. Check the path in kb.toml.'), evidence:role});
	}
	if (options.registered === undefined) {
		check.coverage.unknown++;
		addReason(check, tr('当前入口未提供 Vault 登记状态。','Run the check in the library manager to verify vault registration.'));
	} else {
		check.coverage.checked++;
		if (!options.registered) check.diagnostics.push({severity: 'warning', code: 'unregistered-library', message: tr('当前 Vault 没有登记本库。','This library is not registered in the current vault.')});
	}
	if (options.duplicate === undefined) {
		check.coverage.unknown++;
		addReason(check, tr('当前入口未提供知识库身份重复检查结果。','The current entry point did not provide the result of the duplicate library identity check.'));
	} else {
		check.coverage.checked++;
		if (options.duplicate) check.diagnostics.push({severity: 'error', code: 'duplicate-library', file: 'kb.toml', message: tr('Vault 已登记另一处具有相同身份的知识库。','Another registered library has the same identity. Review the duplicate registration.')});
	}
}

export function inspectProperties(check: DiagnosticCheckResult, inventory: Inventory, templateDirs: readonly string[]) {
	reportInventoryCoverage(check, inventory);
	reportUnreadableNotes(check, inventory);
	for (const note of inventory.notes) {
		if (note.problem?.dynamic && templateDirs.some(dir => note.path.startsWith(dir + '/'))) {
			check.coverage.unknown++;
			addReason(check, tr('有模板的属性只有在实际插入时才能验证。','Check template properties after inserting the template into a note.'));
			continue;
		}
		check.coverage.checked++;
		if (note.problem) check.diagnostics.push({severity: 'error', code: note.problem.code, line: note.problem.line,
			file: note.path, message: tr('Markdown 的 YAML 属性无效。','The Markdown frontmatter contains invalid YAML. Check the indicated line.')});
	}
}

async function inspectStructuredFiles(check: DiagnosticCheckResult, root: string, inventory: Inventory, extension: string,
	inspect: (file: string, text: string) => void | Promise<void>,
	options: {inventoryCoverage?: false; countFiles?: false; onUnreadable?: (diagnostic: Diagnostic) => void; signal?: AbortSignal; trace?: InputTrace} = {}) {
	if (options.inventoryCoverage !== false) reportInventoryCoverage(check, inventory);
	for (const file of inventory.files) {
		if (!file.toLowerCase().endsWith(extension)) continue;
		let text: string;
		try {text = decode(await readRelative(root, file, undefined, options.signal, options.trace));}
		catch {
			options.signal?.throwIfAborted();
			check.coverage.unknown++;
			const diagnostic: Diagnostic = {severity:'info', code:'unreadable-file', file,
				message:tr('文件不可读或超出检查范围限制。','Could not read the file within the scan limits.')};
			check.diagnostics.push(diagnostic);
			options.onUnreadable?.(diagnostic);
			addReason(check, tr('部分检查文件未能读取。','Some files for this check could not be read.'));
			continue;
		}
		if (options.countFiles !== false) check.coverage.checked++;
		await inspect(file, text);
	}
}

const side = new Set(['top','right','bottom','left']);
const arrow = new Set(['none','arrow']);
const type = new Set(['text','file','link','group']);
const backgrounds = new Set(['cover','ratio','repeat']);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const color = (value: unknown) => value === undefined || typeof value === 'string' && /^(?:#[0-9a-f]{6}|[1-6])$/iu.test(value);
const optionalEnum = (value: unknown, domain: Set<string>) => value === undefined || typeof value === 'string' && domain.has(value);

export async function inspectCanvas({canvas, portability}: {canvas?: DiagnosticCheckResult; portability?: DiagnosticCheckResult},
	root: string, inventory: Inventory, options: EvidenceOptions, location: string) {
	const check = canvas ?? portability;
	if (!check) return;
	const checkpoint = diagnosticCheckpoint(options.signal);
	const {resolve, vaultPath, outsideTarget, inspectPortability} = linkResolver(options, inventory, root, location);
	const selected = [canvas, portability].filter((item): item is DiagnosticCheckResult => !!item);
	let deferred = false;
	let unresolvedCanvas = false;
	let unresolvedPortability = false;
	await inspectStructuredFiles(check, root, inventory, '.canvas', async (file, text) => {
		function fail(code: string, message: string, evidence?: string) {canvas?.diagnostics.push({severity:'error', code, message, file, evidence});}
		function uninspectable(code: string, message: string, evidence?: string) {
			fail(code, message, evidence);
			if (portability) {
				portability.coverage.unknown++;
				unresolvedPortability = true;
				portability.diagnostics.push({file, evidence, code, message, severity:'info'});
			}
		}
		let data: unknown;
		try {data = JSON.parse(text);} catch {uninspectable('canvas-json', tr('Canvas 内容不是有效 JSON。','The Canvas file contains invalid JSON.')); return;}
		const structureMessage = tr('Canvas 须含可选的节点与连线数组。','Use arrays for nodes and edges when those fields are present.');
		if (!isRecord(data) || (data.nodes !== undefined && !Array.isArray(data.nodes))) {
			uninspectable('canvas-structure', structureMessage); return;
		}
		if (data.edges !== undefined && !Array.isArray(data.edges)) fail('canvas-structure', structureMessage);
		const source = vaultPath(file);
		const inspectReference = async (link: LinkRequest, details: string) => {
			const exact = link.canvasPath;
			if (dynamicTarget(link.target) || dynamicTarget(link.fragment ?? '')) {
				for (const item of selected) item.coverage.skipped++;
				deferred = true;
				check.diagnostics.push({file,evidence:details,severity:'info',code:'template-link-deferred',message:tr('Canvas 中的模板链接待实例化后检查。','Check the Canvas template link after its variables are filled in.')});
				return;
			}
			const found = await resolve(file, link);
			const evidence = [found.path ?? (relativePath(link.target) ? link.target : undefined), details].filter(Boolean).join(' · ');
			const cross = outsideTarget(found);
			if (portability) await inspectPortability(portability, {file}, link, found, details);
			else if (cross) check.diagnostics.push({file,evidence:[cross.evidence, details].join(' · '), severity:'info',code:'cross-library-link',
				message:tr('Canvas 引用解析到当前知识库之外的 Vault 文件。','The Canvas reference resolves to a vault file outside this library.')});
			const unknownBefore = canvas?.coverage.unknown ?? 0;
			const pdf = canvas && inspectPdfFragment(canvas, link, found, {file,evidence});
			if (found.status === 'unknown') {
				if (canvas) canvas.coverage.unknown++;
				if (portability) unresolvedPortability = true;
				const diagnostic: Diagnostic = {file,evidence,severity:'info',code:exact ? 'canvas-target-unverified' : 'canvas-text-link-unverified',
					message:printable(found.reason,512) ? found.reason : exact
						? tr('未能确认 Canvas 引用的文件。','Could not verify the Canvas file reference.')
						: tr('未能确认 Canvas 文本节点中的链接。','Could not verify the link in the Canvas text node.')};
				for (const item of selected) item.diagnostics.push(diagnostic);
			} else if (canvas) {
				if (found.status === 'resolved' && !pdf && link.fragment && (!found.anchor || found.anchor === 'unknown')) {
					canvas.coverage.unknown++;
					if (exact) canvas.coverage.checked++;
					else canvas.diagnostics.push({file,evidence,severity:'info',code:'canvas-text-link-unverified',message:tr('未能确认文本节点中的链接片段。','Could not verify the link fragment in the Canvas text node.')});
				} else {
					canvas.coverage.checked++;
					if (found.status === 'missing') {
						if (exact) fail('canvas-target-missing',tr('Canvas 引用的文件不存在。','The Canvas references a missing file. Restore it or update the node.'),evidence);
						else canvas.diagnostics.push({file,evidence,...missingLink(link.target,link.kind)});
					} else if (!pdf && link.fragment && found.anchor === 'missing') fail('canvas-anchor-missing',tr('Canvas 引用的标题、块或视图不存在。','The Canvas references a missing heading, block, or view. Check its fragment.'),evidence);
				}
			}
			if (canvas && canvas.coverage.unknown > unknownBefore) unresolvedCanvas = true;
		};
		async function target(value: unknown, details: string, fragment?: string) {
			if (!relativePath(value)) {uninspectable('canvas-file-path', tr('Canvas 文件路径不是有效的 Vault 相对路径。','Use a valid vault-relative path for the Canvas file reference.'),details); return;}
			await inspectReference({source,target:value,fragment,kind:'embed',syntax:'wiki',canvasPath:true}, details);
		}
		async function textLinks(body: string, node: string) {
			for (const occurrence of staticOccurrences({path:file,body,lineOffset:0})) {
				const pause = checkpoint?.();
				if (pause) await pause;
				const details = occurrence.line ? `${node} · ${tr('文本行','Text line')} ${occurrence.line}` : node;
				let link: LinkRequest | undefined;
				try {
					link = linkRequest(source,occurrence);
				} catch {uninspectable('canvas-link-encoding',tr('Canvas 文本节点的链接包含无效 URL 转义。','The Canvas text node contains a link with invalid URL encoding.'),details); continue;}
				if (link) await inspectReference(link, details);
				else for (const item of selected) item.coverage.skipped++;
			}
		}
		const ids = new Set<string>();
		for (const node of (data.nodes ?? []) as unknown[]) {
			const pause = checkpoint?.();
			if (pause) await pause;
			if (!isRecord(node) || !nonempty(node.id) || typeof node.type !== 'string' || !type.has(node.type) ||
				!['x','y','width','height'].every(key => Number.isSafeInteger(node[key])) || !color(node.color)) {
				uninspectable('canvas-node',tr('Canvas 节点的 ID、类型、坐标、尺寸或颜色无效。','Check the Canvas node’s ID, type, coordinates, dimensions, and color.')); continue;
			}
			if (ids.has(node.id)) fail('canvas-duplicate-node',tr('Canvas 节点 ID 重复。','Give each Canvas node a unique ID.'));
			ids.add(node.id);
			const details = printable(node.id,128) ? `${tr('节点','Node')} ${node.id}` : tr('节点','Node');
			if (node.type === 'text') {
				if (typeof node.text !== 'string') uninspectable('canvas-text-node',tr('Canvas 文本节点没有文本。','Supply a text string for the Canvas text node.'),details);
				else await textLinks(node.text, details);
			}
			if (node.type === 'link' && !nonempty(node.url)) fail('canvas-link-node',tr('Canvas 链接节点没有 URL。','Supply a URL for the Canvas link node.'));
			if (node.type === 'group' && ((node.label !== undefined && typeof node.label !== 'string') || !optionalEnum(node.backgroundStyle, backgrounds)))
				fail('canvas-group-node',tr('Canvas 分组标题或背景样式无效。','Check the Canvas group label and background style.'));
			if (node.type === 'file') {
				if (node.subpath !== undefined && (typeof node.subpath !== 'string' || !node.subpath.startsWith('#')))
					fail('canvas-subpath',tr('Canvas 文件节点的子路径须以 # 开头。','Start the Canvas file node’s subpath with #.'));
				await target(node.file, details, typeof node.subpath === 'string' && node.subpath.startsWith('#') ? node.subpath : undefined);
			}
			if (node.type === 'group' && node.background !== undefined) await target(node.background, details);
		}
		if (!canvas || !Array.isArray(data.edges)) return;
		const edges = new Set<string>();
		for (const edge of data.edges as unknown[]) {
			const pause = checkpoint?.();
			if (pause) await pause;
			if (!isRecord(edge) || !nonempty(edge.id) || !nonempty(edge.fromNode) || !nonempty(edge.toNode) ||
				!color(edge.color) || !optionalEnum(edge.fromSide, side) || !optionalEnum(edge.toSide, side) ||
				!optionalEnum(edge.fromEnd, arrow) || !optionalEnum(edge.toEnd, arrow) || (edge.label !== undefined && typeof edge.label !== 'string')) {
				fail('canvas-edge',tr('Canvas 连线的 ID、端点或样式无效。','Check the Canvas edge’s ID, endpoints, and style.')); continue;
			}
			if (edges.has(edge.id)) fail('canvas-duplicate-edge',tr('Canvas 连线 ID 重复。','Give each Canvas edge a unique ID.'));
			edges.add(edge.id);
			if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) fail('canvas-dangling-edge',tr('Canvas 连线引用不存在的节点。','Update or remove the edge that points to a missing Canvas node.'));
		}
	}, {
		signal: options.signal,
		trace: options.trace,
		inventoryCoverage: canvas ? undefined : false,
		countFiles: canvas ? undefined : false,
		onUnreadable: diagnostic => {
			if (canvas && portability) {
				portability.coverage.unknown++;
				portability.diagnostics.push(diagnostic);
				addReason(portability, tr('部分检查文件未能读取。','Some files for this check could not be read.'));
			}
		},
	});
	for (const item of selected) {
		if (deferred) addReason(item, tr('Canvas 中的部分模板链接待实例化后检查。','Check deferred Canvas template links after their variables are filled in.'));
		if (item === canvas ? unresolvedCanvas : unresolvedPortability)
			addReason(item, tr('部分 Canvas 引用或链接未能确认。','Some Canvas references or links could not be verified.'));
	}
}

function validFilter(value: unknown, depth = 0): boolean {
	if (nonempty(value)) return true;
	if (depth >= 32 || !isRecord(value)) return false;
	const entries = Object.entries(value);
	if (entries.length !== 1) return false;
	const [operator, operands] = entries[0]!;
	return ['and','or','not'].includes(operator) && Array.isArray(operands) && operands.every(item => validFilter(item, depth + 1));
}

export async function inspectBases(check: DiagnosticCheckResult, root: string, inventory: Inventory, signal?: AbortSignal, trace?: InputTrace) {
	const checkpoint = diagnosticCheckpoint(signal);
	let dynamicExpressions = 0;
	function inspect(file: string, text: string, line?: number) {
		let base: unknown;
		try {base = parse(text);} catch {/* Invalid schema below. */}
		function fail(code: string, message: string) {check.diagnostics.push({severity:'error', code, message, file, line});}
		if (base === null) return;
		if (!isRecord(base)) {fail('base-yaml',tr('Base 文件须为有效的 YAML 映射。','Use a valid YAML mapping for the Base.')); return;}
		if (base.views !== undefined && (!Array.isArray(base.views) || !base.views.every(isRecord))) {
			fail('base-views',tr('Base 视图须为映射数组。','Define the Base views as a list of mappings.')); return;
		}
		const views = base.views ?? [];
		if (views.some(view => !nonempty(view.type) || !nonempty(view.name))) fail('base-view-identity',tr('Base 视图须声明类型和名称。','Supply a type and name for every Base view.'));
		if (base.properties !== undefined && (!isRecord(base.properties) || !Object.values(base.properties).every(isRecord)))
			fail('base-properties',tr('Base 属性配置须为映射。','Use a mapping for each Base property configuration.'));
		for (const field of ['formulas','summaries']) {
			const value = base[field];
			if (value === undefined) continue;
			if (!isRecord(value) || !Object.values(value).every(nonempty)) fail('base-expression',tr('Base 表达式须为非空字符串。','Write each Base expression as a nonempty string.'));
			else dynamicExpressions += Object.keys(value).length;
		}
		for (const scope of [base, ...views]) {
			if (scope.filters === undefined) continue;
			if (!validFilter(scope.filters)) fail('base-filter',tr('Base 过滤器须用语句或 and/or/not 的嵌套列表。','Use an expression or nested and/or/not lists for the Base filter.'));
			else dynamicExpressions++;
		}
	}
	await inspectStructuredFiles(check, root, inventory, '.base', inspect, {signal,trace});
	reportUnreadableNotes(check, inventory);
	for (const note of inventory.notes) {
		const pause = checkpoint?.();
		if (pause) await pause;
		if (note.problem?.code === 'unclosed-frontmatter') {
			check.coverage.unknown++;
			const message = tr('未找到 YAML 属性的结束标记，无法检查正文中的 Base 代码块。','Could not scan the body for Base blocks because the frontmatter has no closing delimiter.');
			check.diagnostics.push({severity:'info', code:'unverified-markdown-body', file:note.path, line:note.problem.line, message});
			addReason(check, tr('部分 Markdown 正文无法与属性分开。','Some Markdown bodies could not be separated from their frontmatter.'));
		}
		for (const block of fencedBlocks(note.body)) {
			if (block.language !== 'base') continue;
			check.coverage.checked++;
			inspect(note.path, block.source, block.line + note.lineOffset);
		}
	}
	check.coverage.unknown += dynamicExpressions;
	if (dynamicExpressions) addReason(check, tr('动态表达式的运行结果须在 Obsidian 中确认。','Open the Base in Obsidian to verify the results of dynamic expressions.'));
}

import {diagnosticCheckpoint} from './checkpoint.ts';
