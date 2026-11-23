import {tr} from '../i18n.ts';
import {recordChecked} from './checked-items.ts';
import {addReason, reportInventoryCoverage, reportUnreadableNotes} from './coverage.ts';
import {linkRequest, linkResolver, missingLink, staticOccurrences} from './links.ts';
import {recordLinkPlaceholder} from './common-tools.ts';
import {dynamicTarget, isTemplateSource, linkPlaceholder} from './placeholders.ts';
import {inspectPdfFragment} from './references.ts';
import type {EvidenceOptions, InputTrace} from './provenance.ts';
import {decode, readRelative, relativePath} from './snapshot.ts';
import type {Inventory, TemplateSnapshot, manifestSnapshot} from './snapshot.ts';
import type {SourceInclusion} from './source-exclusions.ts';
import {isRecord, printable} from './types.ts';
import type {Diagnostic, DiagnosticCheckResult, DiagnosticOptions, LinkRequest} from './types.ts';

type Manifest = Awaited<ReturnType<typeof manifestSnapshot>>;

export function inspectManifest(check: DiagnosticCheckResult, options: DiagnosticOptions, manifest: Manifest, template: TemplateSnapshot, inventory: Inventory) {
	const {parsed} = manifest;
	recordChecked(check,'kb.toml',tr('清单语法和受管身份','Manifest syntax and managed identity'),
		!parsed ? manifest.reason : parsed.identity ? tr('清单有效，包含受管身份。','Valid manifest with a managed identity.')
			: tr('清单有效，缺少受管身份。','Valid manifest without a managed identity.'));
	if (!parsed) check.diagnostics.push({severity: 'error', code: 'invalid-manifest', file: 'kb.toml', message: manifest.reason});
	else if (!parsed.identity) check.diagnostics.push({severity: 'warning', code: 'legacy-identity', file: 'kb.toml', message: tr('清单没有受管知识库身份。','The manifest has no managed library identity. Review it before adopting this library.')});
	if (template.reason) {
		recordChecked(check,'kb-template.json',tr('模板声明','Template declaration'),template.reason);
		check.diagnostics.push({severity: 'error', code: 'invalid-template', file: 'kb-template.json', message: template.reason});
	}
	if (template.template) {
		const identity = parsed?.identity?.template;
		const compare = identity && identity.id !== 'unknown';
		const drift = compare && (identity.id !== template.template.id || identity.version !== template.template.version);
		recordChecked(check,'kb-template.json',`${template.template.id} @ ${template.template.version}`,
			drift ? tr('模板 ID 或版本与清单不同。','The template ID or version differs from the manifest.') :
				compare ? tr('模板 ID 和版本与清单一致。','The template ID and version match the manifest.') :
					tr('识别到模板 ID 和版本。','The template ID and version were recognized.'));
		if (drift)
			check.diagnostics.push({severity: 'warning', code: 'template-version-drift', file: 'kb-template.json', message: tr('模板声明的 ID 或版本与实例清单不同。','The template ID or version differs from the library manifest. Review both files.')});
	}
	function verifyPath(file: string, candidates: Set<string>, missing: Omit<Diagnostic, 'file'>) {
		const exists = candidates.has(file);
		if (!exists) {
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
		recordChecked(check,file,missing.evidence ? `${tr('清单映射','Manifest mapping')} · ${missing.evidence}`
			: tr('知识库入口','Library entry'),exists ? tr('路径存在。','The path exists.') : missing.message);
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
		recordChecked(check,'kb.toml',tr('Vault 登记状态','Vault registration'),options.registered
			? tr('当前 Vault 已登记。','Registered in the current vault.')
			: tr('当前 Vault 未登记。','Unregistered in the current vault.'));
		if (!options.registered) check.diagnostics.push({severity: 'warning', code: 'unregistered-library', message: tr('当前 Vault 没有登记本库。','This library is not registered in the current vault.')});
	}
	if (options.duplicate === undefined) {
		check.coverage.unknown++;
		addReason(check, tr('当前入口未提供知识库身份重复检查结果。','The current entry point did not provide the result of the duplicate library identity check.'));
	} else {
		recordChecked(check,'kb.toml',tr('受管身份重复检查','Duplicate managed identity'),options.duplicate
			? tr('发现具有相同身份的登记。','A registration has the same identity.')
			: tr('未发现具有相同身份的登记。','No duplicate registration was found.'));
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
		recordChecked(check,note.path,tr('Markdown YAML 属性','Markdown YAML frontmatter'),note.problem
			? tr('属性语法无效。','Frontmatter syntax is invalid.')
			: note.properties ? tr('属性语法有效。','Frontmatter syntax is valid.')
				: tr('没有 YAML 属性。','No YAML frontmatter.'),note.problem?.line);
		if (note.problem) check.diagnostics.push({severity: 'error', code: note.problem.code, line: note.problem.line,
			file: note.path, message: tr('Markdown 的 YAML 属性无效。','The Markdown frontmatter contains invalid YAML. Check the indicated line.')});
	}
}

async function inspectStructuredFiles(check: DiagnosticCheckResult, root: string, inventory: Inventory, extension: string,
	inspect: (file: string, text: string) => void | Promise<void>,
	options: {inventoryCoverage?: false; includes?: (file: string) => boolean; onUnreadable?: (file: string, diagnostic: Diagnostic) => void;
		signal?: AbortSignal; trace?: InputTrace} = {}) {
	if (options.inventoryCoverage !== false) reportInventoryCoverage(check, inventory);
	for (const file of inventory.files) {
		if (!file.toLowerCase().endsWith(extension) || options.includes?.(file) === false) continue;
		let text: string;
		try {text = decode(await readRelative(root, file, undefined, options.signal, options.trace));}
		catch {
			options.signal?.throwIfAborted();
			check.coverage.unknown++;
			const diagnostic: Diagnostic = {severity:'info', code:'unreadable-file', file,
				message:tr('文件不可读或超出检查范围限制。','Could not read the file within the scan limits.')};
			check.diagnostics.push(diagnostic);
			options.onUnreadable?.(file,diagnostic);
			addReason(check, tr('部分检查文件未能读取。','Some files for this check could not be read.'));
			continue;
		}
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

export async function inspectCanvas({canvas, portability: portabilityCheck}: {canvas?: DiagnosticCheckResult; portability?: DiagnosticCheckResult},
	root: string, inventory: Inventory, options: EvidenceOptions, location: string, includes: SourceInclusion, templateDirs: readonly string[]) {
	const check = canvas ?? portabilityCheck;
	if (!check) return;
	const checkpoint = diagnosticCheckpoint(options.signal);
	const {resolve, vaultPath, outsideTarget, inspectPortability} = linkResolver(options, inventory, root, location);
	const selected = [canvas, portabilityCheck].filter((item): item is DiagnosticCheckResult => !!item);
	const deferred = new Set<DiagnosticCheckResult>();
	let unresolvedCanvas = false;
	let unresolvedPortability = false;
	await inspectStructuredFiles(check, root, inventory, '.canvas', async (file, text) => {
		const portability = includes('portability',file) ? portabilityCheck : undefined;
		const fileChecks = portability ? selected : canvas ? [canvas] : [];
		let structureFailure: string | undefined;
		function fail(code: string, message: string, evidence?: string) {
			structureFailure ??= message;
			canvas?.diagnostics.push({severity:'error', code, message, file, evidence});
		}
		function recordStructure() {
			if (canvas) recordChecked(canvas,file,tr('Canvas JSON、节点与连线','Canvas JSON, nodes, and edges'),
				structureFailure ?? tr('Canvas 结构有效。','The Canvas structure is valid.'));
		}
		function uninspectable(code: string, message: string, evidence?: string) {
			fail(code, message, evidence);
			if (portability) {
				portability.coverage.unknown++;
				unresolvedPortability = true;
				portability.diagnostics.push({file, evidence, code, message, severity:'info'});
			}
		}
		let data: unknown;
		try {data = JSON.parse(text);} catch {
			uninspectable('canvas-json', tr('Canvas 内容不是有效 JSON。','The Canvas file contains invalid JSON.'));
			recordStructure();
			return;
		}
		const structureMessage = tr('Canvas 须含可选的节点与连线数组。','Use arrays for nodes and edges when those fields are present.');
		if (!isRecord(data) || (data.nodes !== undefined && !Array.isArray(data.nodes))) {
			uninspectable('canvas-structure', structureMessage);
			recordStructure();
			return;
		}
		if (data.edges !== undefined && !Array.isArray(data.edges)) fail('canvas-structure', structureMessage);
		const source = vaultPath(file);
		const inTemplate = isTemplateSource(file,templateDirs);
		const inspectReference = async (link: LinkRequest, details: string) => {
			const exact = link.canvasPath;
			const placeholder = linkPlaceholder(link,inTemplate,true);
			if (placeholder) {
				for (const item of fileChecks) {
					recordLinkPlaceholder(item,placeholder,{file,evidence:details},item === check);
					if (placeholder.coverage === 'skipped') deferred.add(item);
					if (placeholder.coverage === 'unknown') {
						if (item === canvas) unresolvedCanvas = true;
						else unresolvedPortability = true;
					}
				}
				return;
			}
			const found = await resolve(file, link);
			const evidence = [found.path ?? (relativePath(link.target) ? link.target : undefined), details].filter(Boolean).join(' · ');
			const cross = outsideTarget(found);
			if (portability) await inspectPortability(portability, {file}, link, found, details);
			else if (cross) check.diagnostics.push({file,evidence:[cross.evidence, details].join(' · '), severity:'info',code:'cross-library-link',
				message:tr('Canvas 引用解析到当前知识库之外的 Vault 文件。','The Canvas reference resolves to a vault file outside this library.')});
			const unknownBefore = canvas?.coverage.unknown ?? 0;
			const pdf = canvas && inspectPdfFragment(canvas, link, found, {file,evidence}, details);
			if (found.status === 'unknown') {
				if (canvas) canvas.coverage.unknown++;
				if (portability) unresolvedPortability = true;
				const diagnostic: Diagnostic = {file,evidence,severity:'info',code:exact ? 'canvas-target-unverified' : 'canvas-text-link-unverified',
					message:printable(found.reason,512) ? found.reason : exact
						? tr('未能确认 Canvas 引用的文件。','Could not verify the Canvas file reference.')
						: tr('未能确认 Canvas 文本节点中的链接。','Could not verify the link in the Canvas text node.')};
				for (const item of fileChecks) item.diagnostics.push(diagnostic);
			} else if (canvas) {
				const fileSubject = `${details} · ${link.target || file}`;
				const resolved = `${tr('目标文件','Target file')} · ${found.path}`;
				if (found.status === 'resolved' && !pdf && link.fragment && (!found.anchor || found.anchor === 'unknown')) {
					canvas.coverage.unknown++;
					if (exact) recordChecked(canvas,file,fileSubject,resolved);
					else canvas.diagnostics.push({file,evidence,severity:'info',code:'canvas-text-link-unverified',message:tr('未能确认文本节点中的链接片段。','Could not verify the link fragment in the Canvas text node.')});
				} else {
					const fragment = pdf ? undefined : link.fragment;
					const anchorMissing = fragment && found.anchor === 'missing';
					recordChecked(canvas,file,fileSubject + (fragment ?? ''),found.status === 'missing'
						? tr('目标文件不存在。','The target file is missing.') :
						anchorMissing ? tr('缺少引用的标题、块或视图。','The referenced heading, block, or view is missing.') :
							fragment ? tr('找到引用的标题、块或视图。','The referenced heading, block, or view was found.') : resolved);
					if (found.status === 'missing') {
						if (exact) canvas.diagnostics.push({file,evidence,severity:'error',code:'canvas-target-missing',
							message:tr('Canvas 引用的文件不存在。','The Canvas references a missing file. Restore it or update the node.')});
						else canvas.diagnostics.push({file,evidence,...missingLink(link.target,link.kind)});
					} else if (anchorMissing) canvas.diagnostics.push({file,evidence,severity:'error',code:'canvas-anchor-missing',
						message:tr('Canvas 引用的标题、块或视图不存在。','The Canvas references a missing heading, block, or view. Check its fragment.')});
				}
			}
			if (canvas && canvas.coverage.unknown > unknownBefore) unresolvedCanvas = true;
		};
		async function target(value: unknown, details: string, fragment?: string) {
			if (typeof value !== 'string' || !dynamicTarget(value) && !relativePath(value)) {uninspectable('canvas-file-path', tr('Canvas 文件路径不是有效的 Vault 相对路径。','Use a valid vault-relative path for the Canvas file reference.'),details); return;}
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
				else for (const item of fileChecks) item.coverage.skipped++;
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
		if (!canvas || !Array.isArray(data.edges)) {
			recordStructure();
			return;
		}
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
		recordStructure();
	}, {
		signal: options.signal,
		trace: options.trace,
		inventoryCoverage: canvas ? undefined : false,
		includes: file => !!canvas || includes('portability',file),
		onUnreadable: (file, diagnostic) => {
			if (canvas && portabilityCheck && includes('portability',file)) {
				portabilityCheck.coverage.unknown++;
				portabilityCheck.diagnostics.push(diagnostic);
				addReason(portabilityCheck, tr('部分检查文件未能读取。','Some files for this check could not be read.'));
			}
		},
	});
	for (const item of selected) {
		if (deferred.has(item)) addReason(item, tr('Canvas 中的部分模板链接待实例化后检查。','Check deferred Canvas template links after their variables are filled in.'));
		if (item === canvas ? unresolvedCanvas : unresolvedPortability)
			addReason(item, tr('部分 Canvas 引用或链接未能确认。','Some Canvas references or links could not be verified.'));
	}
}

import {diagnosticCheckpoint} from './checkpoint.ts';
