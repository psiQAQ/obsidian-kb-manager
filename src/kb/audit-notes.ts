import { isScalar, parse, parseDocument, visit } from 'yaml';
import { tr } from '../i18n.ts';
import type { Mapping } from './mapping.ts';
import { within } from './audit-types.ts';
import type { AuditNote, AuditReport } from './audit-types.ts';

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readNote(text: string): AuditNote {
	const lines = text.replace(/^\uFEFF/u,'').split(/\r?\n/u);
	if (lines[0]?.trim() !== '---') return {metadata:{}, body:text};
	const end = lines.findIndex((line,i) => i > 0 && ['---','...'].includes(line.trim()));
	if (end < 0) throw new Error(tr('缺少 YAML 属性的结束标记','Missing frontmatter closing delimiter'));
	const doc = parseDocument(lines.slice(1,end).join('\n'), {version:'1.1'});
	const error = doc.errors[0];
	if (error) throw error;
	visit(doc,{
		Pair(_,pair) {
			if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
				throw new Error(tr('YAML 属性名须为文本','YAML property names must be strings'));
		},
		Scalar(_,node) {
			const raw = node.source;
			if (node.value instanceof Date && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(raw) && !validDate(raw))
				throw new Error(tr('YAML 日期无效','Invalid YAML calendar date') + ': ' + String(raw));
		},
	});
	const header: unknown = doc.toJS();
	if (header != null && !object(header)) throw new Error(tr('属性必须是键值映射','Frontmatter must be a mapping'));
	if (object(header)) for (const field of ['created','updated','archived']) {
		const value = doc.get(field,true);
		if (isScalar(value) && value.value instanceof Date && validDate(value.source)) header[field] = value.source;
	}
	return {metadata:header ?? {}, body:lines.slice(end + 1).join('\n')};
}

export function validDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
	const date = new Date(value + 'T00:00:00Z');
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}

const articleTypes = new Set(['source','entity','concept','analysis','archive','overview','category']);
const adminTypes = new Set(['index','log','report','document','dashboard']);

export function inspectPage(file: string, {metadata:m}: AuditNote, mapping: Mapping, report: AuditReport): boolean {
	const type = m.type;
	if (type != null && typeof type !== 'string') {
		report('error','page-type',file,tr('type 必须是文本','type must be text'));
		return false;
	}
	if (m.managed_by != null && m.managed_by !== 'human' && m.managed_by !== 'agent')
		report('error','managed-by',file,tr('managed_by 应为 agent 或 human','Expected agent or human for managed_by'));
	if (['README.md','LICENSES.md','AGENTS.md',mapping.index,mapping.log].includes(file) || within(file,mapping.reports) || adminTypes.has(String(type))) return false;
	const owned = m.managed_by === 'agent';
	const article = owned && articleTypes.has(String(type));
	if (owned) {
		if (!within(file,mapping.wiki)) report('error','generated-location',file,tr('知识页位于 wiki 映射之外','Generated knowledge is outside the wiki folder'));
		if (!article) report('error','page-type',file,tr('知识页类型无效','Unknown knowledge page type') + ': ' + String(type));
	} else {
		if (!within(file,mapping.notes)) report('review','human-location',file,tr('请确认受保护笔记的位置和归属','Review the location and ownership of the protected note'));
		const missing = ['type','managed_by','categories','tags','aliases','created'].filter(key => !(key in m));
		if (missing.length) report('review','human-properties',file,tr('人工笔记缺少属性','Missing human note properties') + ': ' + missing.join(', '));
	}
	for (const key of ['categories','tags','aliases','sources']) {
		if (!owned && !(key in m)) continue;
		const value = m[key];
		if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) report('error','property-type',file,key + tr(' 应为字符串列表',' must be a list of strings'));
	}
	for (const key of ['created','updated','archived']) {
		if (m[key] != null && !validDate(m[key])) report('error','date-format',file,key + tr(' 日期须为 YYYY-MM-DD',' must be a YYYY-MM-DD date'));
	}
	if (owned && !(type === 'overview' && m.status === 'empty')) {
		for (const key of type === 'archive' ? ['created','archived'] : ['created','updated']) {
			if (!validDate(m[key])) report('error','date-missing',file,tr('缺少有效日期','Missing valid date') + ': ' + key);
		}
	}
	return article;
}

export function inspectBase(file: string, text: string, checkBindings: boolean, report: AuditReport) {
	const base: unknown = parse(text);
	if (base == null) return;
	if (!object(base)) throw new Error(tr('Base 顶层须为映射','Base must be a mapping'));
	const views = base.views === undefined ? [] : base.views;
	if (!Array.isArray(views) || !views.every(object)) throw new Error(tr('views 须为视图映射列表','views must be a list of mappings'));
	for (const scope of [base,...views]) {
		if ('filters' in scope && typeof scope.filters !== 'string' && !object(scope.filters))
			throw new Error(tr('filters 须为表达式或映射','filters must be an expression or mapping'));
	}
	if (!checkBindings) return;
	const tokens = new Set(text.match(/__(?:KB_ROOT|WIKI_PATH|NOTES_PATH|WIKI_DIR|TEMPLATES_DIR|CATEGORY_PATH)__/gu));
	if (tokens.size) report('error','base-binding-missing',file,tr('Base 中有未替换的绑定','Unresolved Base placeholders') + ': ' + [...tokens].join(', '));
}
