import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument, isScalar } from 'yaml';
import { segments } from '../fs/paths.ts';
import { digest, key, statIfPresent } from '../fs/vault.ts';

export interface TemplateFile { name: string; bytes: Uint8Array }
export interface Template {
	id: string; version: string; entry?: string;
	overview?: boolean; files: TemplateFile[]; folders: string[]; excluded: string[];
}
export interface Variables { displayName: string; description: string; destination: string }

export function renderBase(source: string, root: string): string {
	const doc = parseDocument(source, { keepSourceTokens: true });
	if (doc.errors.length) throw new Error(doc.errors[0]?.message);
	const bindings: Record<string, string> = { __KB_ROOT__: root, __WIKI_PATH__: root + '/wiki', __NOTES_PATH__: root + '/Notes' };
	const filters = [['filters', 'and', 0], ['filters', 'and', 1],
		['views', 0, 'filters', 'and', 3], ['views', 1, 'filters', 'and', 0],
		['views', 2, 'filters', 'and', 3], ['views', 3, 'filters', 'and', 0]];
	for (const field of filters) {
		const node = doc.getIn(field, true);
		if (!isScalar(node) || typeof node.value !== 'string' || !/__KB_ROOT__|__WIKI_PATH__|__NOTES_PATH__/u.test(node.value)) {
			throw new Error(fromEnglish('Invalid built-in Base binding: ','内置 Base 绑定无效：') + field.join('.'));
		}
		node.value = node.value.replace(/__KB_ROOT__|__WIKI_PATH__|__NOTES_PATH__/gu,
			token => JSON.stringify(bindings[token]).slice(1, -1));
	}
	return doc.toString({lineWidth: 0});
}

export function builtinTemplate(skeleton: Record<string,string>, vars: Variables): Template {
	const files = Object.entries(skeleton).map(([name, text]) => {
		if (name === 'README.md') text = text.replace(/\{\{kb_name\}\}|\{\{description\}\}/gu,
			token => token === '{{kb_name}}' ? vars.displayName : vars.description);
		if (name === 'knowledge.base') text = renderBase(text, vars.destination);
		return { name, bytes: Buffer.from(text) };
	});
	return { id:'llm-wiki', version:'1', entry:'wiki/index.md', files, folders:[], excluded:[] };
}

const excludedNames = new Set(['.git','.cache','.venv','__pycache__','node_modules']);
interface Declaration {
	id?: string; version?: string; entry?: string;
	managed?: string[]; hidden?: string[]; text?: Record<string,string[]>;
}

function declaration(raw: string): Declaration {
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(fromEnglish('Invalid template declaration','模板声明无效'));
	const data = value as Record<string, unknown>;
	for (const name of Object.keys(data)) {
		if (!['id','version','entry','hidden','text','managed'].includes(name)) throw new Error(fromEnglish('Unknown template field: ','未知的模板字段：') + name);
	}
	for (const name of ['id','version','entry']) {
		if (name in data && (typeof data[name] !== 'string' || !data[name])) throw new Error(fromEnglish('Invalid template ','无效的模板字段：') + name);
	}
	if (typeof data.entry === 'string') segments(data.entry);
	if ('hidden' in data && (!Array.isArray(data.hidden) || !data.hidden.every(v => typeof v === 'string'))) {
		throw new Error(fromEnglish('Invalid hidden file list','隐藏文件清单无效'));
	}
	if ('managed' in data && (!Array.isArray(data.managed) || data.managed.length !== 1 || data.managed[0] !== 'knowledge.base:overview-bindings')) {
		throw new Error(fromEnglish('Unknown managed field declaration','未知的受管字段声明'));
	}
	if ('text' in data) {
		if (!data.text || typeof data.text !== 'object' || Array.isArray(data.text)) throw new Error(fromEnglish('Invalid text declarations','文本声明无效'));
		for (const [file, fields] of Object.entries(data.text)) {
			segments(file);
			if (!Array.isArray(fields) || !fields.every(v => ['kb_name','description','kb_root'].includes(String(v)))) {
				throw new Error(fromEnglish('Invalid variables for ','文件的变量声明无效：') + file);
			}
		}
	}
	return data;
}

export async function folderTemplate(root: string, configDir: string, vars: Variables): Promise<Template> {
	const specName = 'kb-template.json';
	const specPath = path.join(root, specName);
	const specStat = await statIfPresent(specPath);
	if (specStat && !specStat.isFile()) throw new Error(fromEnglish('Expected a regular template declaration','模板声明必须为常规文件'));
	const spec = specStat ? declaration(await fs.readFile(specPath,'utf8')) : {};
	const files: TemplateFile[] = [], folders: string[] = [], excluded: string[] = [];
	const sourceFiles: string[] = [];
	const variables: Record<string,string> = {kb_name:vars.displayName,description:vars.description,kb_root:vars.destination};
	async function walk(relative: string) {
		const directory = path.join(root,relative);
		const names = (await fs.readdir(directory)).sort();
		if (new Set(names.map(key)).size !== names.length) throw new Error(fromEnglish('Template name collision: ','模板路径名称冲突：') + relative);
		for (const name of names) {
			const file = relative ? relative + '/' + name : name;
			const absolute = path.join(root,file);
			if (key(name) === 'kb-manager.json') throw new Error(fromEnglish('Template contains a knowledge base identity: ','模板含知识库身份文件：') + file);
			if (key(name) === key(configDir) || excludedNames.has(key(name)) || file === specName ||
				(name.startsWith('.') && !['.gitignore','.gitkeep'].includes(name) && !spec.hidden?.includes(file))) {
				excluded.push(file); continue;
			}
			segments(name.startsWith('.') ? 'hidden' + name : name);
			const stat = await fs.lstat(absolute);
			if (stat.isDirectory()) { folders.push(file); await walk(file); continue; }
			if (!stat.isFile()) throw new Error(fromEnglish('Expected a regular template file: ','模板项必须为常规文件：') + file);
			let bytes: Uint8Array = await fs.readFile(absolute);
			sourceFiles.push(file + ':' + digest(bytes));
			const fields = spec.text?.[file];
			if (fields) {
				const original = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
				bytes = Buffer.from(original.replace(/\{\{(kb_name|description|kb_root)\}\}/gu,(token,field: string) =>
					fields.includes(field) ? variables[field] ?? token : token));
			}
			if (file === 'knowledge.base' && spec.managed?.length) {
				const original = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
				bytes = Buffer.from(renderBase(original,vars.destination));
			}
			files.push({name:file, bytes});
		}
	}
	await walk('');
	for (const name of [...Object.keys(spec.text ?? {}), ...(spec.managed?.length ? ['knowledge.base'] : []), ...(spec.entry ? [spec.entry] : [])]) {
		if (!files.some(file => file.name === name)) throw new Error(fromEnglish('Missing declared file: ','缺少已声明的文件：') + name);
	}
	return { id:spec.id ?? 'folder', version:spec.version ?? digest(JSON.stringify([spec,folders,sourceFiles])),
		overview:!!spec.managed?.length, entry:spec.entry, files, folders, excluded };
}
