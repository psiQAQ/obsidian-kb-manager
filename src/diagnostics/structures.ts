import {parse} from 'yaml';
import {tr} from '../i18n.ts';
import {fencedBlocks} from './fences.ts';
import {dynamicTarget, linkRequest, linkResolver, missingLink, staticOccurrences} from './links.ts';
import {decode, hash, readRelative, relativePath} from './snapshot.ts';
import type {Inventory, TemplateSnapshot, manifestSnapshot} from './snapshot.ts';
import {isRecord} from './types.ts';
import type {DiagnosticCheckResult, DiagnosticOptions} from './types.ts';

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
	const entry = parsed?.identity?.entry ?? template.template?.entry;
	if (entry) {
		check.coverage.checked++;
		if (!inventory.files.has(entry)) check.diagnostics.push({severity: 'error', code: 'missing-entry', file: entry, message: tr('清单指定的入口文件不存在。','The configured entry file is missing. Restore it or update its path.')});
	}
	for (const [role, relative] of Object.entries(manifest.paths ?? {})) {
		if (!relativePath(relative) || relative === entry) continue;
		check.coverage.checked++;
		const candidates = ['overview','index','log'].includes(role) ? inventory.files : inventory.directories;
		if (!candidates.has(relative)) check.diagnostics.push({severity:'error', code:'missing-mapping', file:relative, message:tr('清单映射的文件或目录不存在。','The mapped file or folder is missing. Check the path in kb.toml.'), evidence:role});
	}
	if (options.registered === undefined) {
		check.coverage.unknown++;
		check.reason = tr('当前入口未提供 Vault 登记状态。','Run the check in the library manager to verify vault registration.');
	} else {
		check.coverage.checked++;
		if (!options.registered) check.diagnostics.push({severity: 'warning', code: 'unregistered-library', message: tr('当前 Vault 没有登记本库。','This library is not registered in the current vault.')});
	}
	if (options.duplicate) check.diagnostics.push({severity: 'error', code: 'duplicate-library', file: 'kb.toml', message: tr('Vault 已登记另一处具有相同身份的知识库。','Another registered library has the same identity. Review the duplicate registration.')});
}

export function inspectProperties(check: DiagnosticCheckResult, inventory: Inventory, templateDirs: readonly string[]) {
	check.coverage.skipped = inventory.skipped;
	for (const note of inventory.notes) {
		if (note.problem && templateDirs.some(dir => note.path.startsWith(dir + '/'))) {
			check.coverage.unknown++;
			check.reason = tr('有模板的属性只有在实际插入时才能验证。','Check template properties after inserting the template into a note.');
			continue;
		}
		check.coverage.checked++;
		if (note.problem) check.diagnostics.push({severity: 'error', code: note.problem.code, line: note.problem.line,
			file: note.path, message: tr('Markdown 的 YAML 属性无效。','The Markdown frontmatter contains invalid YAML. Check the indicated line.')});
	}
	check.coverage.unknown += inventory.unreadable.length;
	for (const file of inventory.unreadable) check.diagnostics.push({severity: 'info', code: 'unreadable-note', file, message: tr('文件不可读或超出扫描范围限制。','Could not read the file within the scan limits. Check its permissions and size.')});
}

async function inspectStructuredFiles(check: DiagnosticCheckResult, root: string, inventory: Inventory, extension: string,
	inspect: (file: string, text: string) => void | Promise<void>) {
	for (const file of inventory.files) {
		if (!file.toLowerCase().endsWith(extension)) continue;
		let text: string;
		try {text = decode(await readRelative(root, file));}
		catch {check.coverage.unknown++; check.diagnostics.push({severity:'info', code:'unreadable-file', file, message:tr('文件不可读或超出检查范围限制。','Could not read the file within the scan limits. Check its permissions and size.')}); continue;}
		check.coverage.checked++;
		await inspect(file, text);
	}
	check.coverage.skipped = inventory.skipped;
}

const side = new Set(['top','right','bottom','left']);
const arrow = new Set(['none','arrow']);
const type = new Set(['text','file','link','group']);
const backgrounds = new Set(['cover','ratio','repeat']);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const color = (value: unknown) => value === undefined || typeof value === 'string' && /^(?:#[0-9a-f]{6}|[1-6])$/iu.test(value);
const optionalEnum = (value: unknown, domain: Set<string>) => value === undefined || typeof value === 'string' && domain.has(value);

export async function inspectCanvas(check: DiagnosticCheckResult, root: string, inventory: Inventory, options: DiagnosticOptions, location: string) {
	const {resolve, vaultPath} = linkResolver(options, inventory, root, location);
	await inspectStructuredFiles(check, root, inventory, '.canvas', async (file, text) => {
		function fail(code: string, message: string) {check.diagnostics.push({severity:'error', code, message, file});}
		let data: unknown;
		try {data = JSON.parse(text);} catch {fail('canvas-json', tr('Canvas 内容不是有效 JSON。','The Canvas file contains invalid JSON.')); return;}
		if (!isRecord(data) || (data.nodes !== undefined && !Array.isArray(data.nodes)) || (data.edges !== undefined && !Array.isArray(data.edges))) {
			fail('canvas-structure', tr('Canvas 须含可选的节点与连线数组。','Use arrays for nodes and edges when those fields are present.')); return;
		}
		async function target(value: unknown, fragment?: string) {
			if (!relativePath(value)) {fail('canvas-file-path', tr('Canvas 文件路径不是有效的 Vault 相对路径。','Use a valid vault-relative path for the Canvas file reference.')); return;}
			const found = await resolve(file, {source:vaultPath(file), target:value, fragment, kind:'embed', syntax:'wiki', canvasPath:true});
			if (found.status === 'unknown') {
				check.coverage.unknown++;
				check.diagnostics.push({file,severity:'info',code:'canvas-target-unverified',message:tr('未能确认 Canvas 引用的文件。','Could not verify the Canvas file reference.'),evidence:value});
			}
			else {
				check.coverage.checked++;
				if (found.status === 'missing') fail('canvas-target-missing',tr('Canvas 引用的文件不存在。','The Canvas references a missing file. Restore it or update the node.'));
				else if (fragment && found.anchor === 'missing') fail('canvas-anchor-missing',tr('Canvas 引用的标题或块不存在。','The Canvas references a missing heading or block. Check the node’s subpath.'));
				else if (fragment && found.anchor !== 'resolved') check.coverage.unknown++;
			}
		}
		async function textLinks(body: string) {
			for (const occurrence of staticOccurrences({path:file,body,lineOffset:0})) {
				try {
					const link = linkRequest(vaultPath(file),occurrence);
					if (!link || dynamicTarget(link.target) || dynamicTarget(link.fragment ?? '')) {check.coverage.skipped++; continue;}
					const found = await resolve(file,link);
					const evidence = found.path ?? (relativePath(link.target) ? link.target : undefined);
					if (found.status === 'unknown' || found.status === 'resolved' && link.fragment && (!found.anchor || found.anchor === 'unknown')) {
						check.coverage.unknown++;
						check.diagnostics.push({file,evidence,severity:'info',code:'canvas-text-link-unverified',message:tr('未能确认文本节点中的链接或片段。','Could not verify the link or fragment in the Canvas text node.')});
					} else {
						check.coverage.checked++;
						if (found.status === 'missing') check.diagnostics.push({file,evidence,...missingLink(link.target,link.kind)});
						else if (found.anchor === 'missing') fail('canvas-anchor-missing',tr('Canvas 文本节点的链接引用不存在的标题、块或视图。','The Canvas text node links to a missing heading, block, or view. Check the link fragment.'));
					}
				} catch {fail('canvas-link-encoding',tr('Canvas 文本节点的链接包含无效 URL 转义。','The Canvas text node contains a link with invalid URL encoding.'));}
			}
		}
		const ids = new Set<string>();
		for (const node of (data.nodes ?? []) as unknown[]) {
			if (!isRecord(node) || !nonempty(node.id) || typeof node.type !== 'string' || !type.has(node.type) ||
				!['x','y','width','height'].every(key => Number.isSafeInteger(node[key])) || !color(node.color)) {
				fail('canvas-node',tr('Canvas 节点的 ID、类型、坐标、尺寸或颜色无效。','Check the Canvas node’s ID, type, coordinates, dimensions, and color.')); continue;
			}
			if (ids.has(node.id)) fail('canvas-duplicate-node',tr('Canvas 节点 ID 重复。','Give each Canvas node a unique ID.'));
			ids.add(node.id);
			if (node.type === 'text') {
				if (typeof node.text !== 'string') fail('canvas-text-node',tr('Canvas 文本节点没有文本。','Supply a text string for the Canvas text node.'));
				else await textLinks(node.text);
			}
			if (node.type === 'link' && !nonempty(node.url)) fail('canvas-link-node',tr('Canvas 链接节点没有 URL。','Supply a URL for the Canvas link node.'));
			if (node.type === 'group' && ((node.label !== undefined && typeof node.label !== 'string') || !optionalEnum(node.backgroundStyle, backgrounds)))
				fail('canvas-group-node',tr('Canvas 分组标题或背景样式无效。','Check the Canvas group label and background style.'));
			if (node.type === 'file') {
				if (node.subpath !== undefined && (typeof node.subpath !== 'string' || !node.subpath.startsWith('#')))
					fail('canvas-subpath',tr('Canvas 文件节点的子路径须以 # 开头。','Start the Canvas file node’s subpath with #.'));
				await target(node.file, typeof node.subpath === 'string' && node.subpath.startsWith('#') ? node.subpath : undefined);
			}
			if (node.type === 'group' && node.background !== undefined) await target(node.background);
		}
		const edges = new Set<string>();
		for (const edge of (data.edges ?? []) as unknown[]) {
			if (!isRecord(edge) || !nonempty(edge.id) || !nonempty(edge.fromNode) || !nonempty(edge.toNode) ||
				!color(edge.color) || !optionalEnum(edge.fromSide, side) || !optionalEnum(edge.toSide, side) ||
				!optionalEnum(edge.fromEnd, arrow) || !optionalEnum(edge.toEnd, arrow) || (edge.label !== undefined && typeof edge.label !== 'string')) {
				fail('canvas-edge',tr('Canvas 连线的 ID、端点或样式无效。','Check the Canvas edge’s ID, endpoints, and style.')); continue;
			}
			if (edges.has(edge.id)) fail('canvas-duplicate-edge',tr('Canvas 连线 ID 重复。','Give each Canvas edge a unique ID.'));
			edges.add(edge.id);
			if (!ids.has(edge.fromNode) || !ids.has(edge.toNode)) fail('canvas-dangling-edge',tr('Canvas 连线引用不存在的节点。','Update or remove the edge that points to a missing Canvas node.'));
		}
	});
	if (check.coverage.unknown) check.reason = tr('部分 Canvas 文件引用、附件、锚点或文本节点内的链接未能确认。','Some Canvas file references, attachments, anchors, or links in text nodes could not be verified.');
}

function validFilter(value: unknown, depth = 0): boolean {
	if (nonempty(value)) return true;
	if (depth >= 32 || !isRecord(value)) return false;
	const entries = Object.entries(value);
	if (entries.length !== 1) return false;
	const [operator, operands] = entries[0]!;
	return ['and','or','not'].includes(operator) && Array.isArray(operands) && operands.every(item => validFilter(item, depth + 1));
}

export async function inspectBases(check: DiagnosticCheckResult, root: string, inventory: Inventory, templateDirs: readonly string[]) {
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
			else check.coverage.unknown += Object.keys(value).length;
		}
		for (const scope of [base, ...views]) {
			if (scope.filters === undefined) continue;
			if (!validFilter(scope.filters)) fail('base-filter',tr('Base 过滤器须用语句或 and/or/not 的嵌套列表。','Use an expression or nested and/or/not lists for the Base filter.'));
			else check.coverage.unknown++;
		}
		if (!templateDirs.some(dir => file.startsWith(dir + '/')) && /__(?:KB_ROOT|WIKI_PATH|NOTES_PATH|WIKI_DIR|TEMPLATES_DIR|CATEGORY_PATH)__/u.test(text))
			fail('base-unbound-placeholder',tr('Base 仍有未绑定的模板占位符。','Fill in the remaining template placeholders in the Base.'));
	}
	await inspectStructuredFiles(check, root, inventory, '.base', inspect);
	for (const note of inventory.notes) for (const block of fencedBlocks(note.body)) {
		if (block.language !== 'base') continue;
		check.coverage.checked++;
		inspect(note.path, block.source, block.line + note.lineOffset);
	}
	if (check.coverage.unknown) check.reason = tr('动态表达式的运行结果须在 Obsidian 中确认。','Open the Base in Obsidian to verify the results of dynamic expressions.');
}

export async function inspectBindings(check: DiagnosticCheckResult, manifest: Manifest, root: string, location?: string) {
	if (!manifest.parsed) {check.coverage.unknown++; check.reason = manifest.reason; return;}
	for (const binding of manifest.parsed.identity?.managed ?? []) {
		try {
			const contents = await readRelative(root, binding.path);
			check.coverage.checked++;
			if (hash(contents) !== binding.fingerprint) check.diagnostics.push({severity:'warning', code:'binding-drift', file:binding.path, message:tr('受管文件内容与登记指纹不同，请复核绑定。','The managed file differs from its saved fingerprint. Review its bindings.')});
			if (binding.root && location !== undefined && binding.root !== location)
				check.diagnostics.push({severity:'warning', code:'binding-root-drift', file:binding.path, message:tr('受管绑定仍记录其他 Vault 路径。','The managed binding still records a different vault path. Review it before repairing the binding.')});
			if (binding.root && location === undefined) check.coverage.unknown++;
		} catch (error) {
			const missing = isRecord(error) && error.code === 'ENOENT';
			check.coverage[missing ? 'checked' : 'unknown']++;
			check.diagnostics.push({severity:missing ? 'warning' : 'info', code:missing ? 'missing-binding' : 'binding-unverified',
				file:binding.path, message:missing ? tr('清单登记的受管文件缺失。','The managed file in the manifest is missing. Restore it or review its binding.') :
					tr('无法核对受管文件。','Could not verify the managed file. Check its path and permissions.')});
		}
	}
	if (check.coverage.unknown) check.reason = tr('受管文件不可读或当前入口没有提供 Vault 相对位置。','Some managed files were unreadable or their vault-relative location was unavailable.');
}
