import {builtinAttributesFile} from '../git/markdown-attributes.ts';
import { fromEnglish } from '../i18n.ts';
import { segments } from '../fs/segments.ts';
import { renderKepano } from './kepano.ts';
import { parseDocument, isScalar } from 'yaml';

export interface TemplateFile { name: string; bytes: Uint8Array }
export interface Template {
	id: string; version: string; entry?: string;
	overview?: boolean; files: TemplateFile[]; folders: string[]; excluded: string[];
}
export interface Variables { displayName: string; description: string; destination: string }

export const kepanoSource = 'builtin:kepano';
type TemplateIdentity = Pick<Template,'id'|'version'>;
export type BuiltinKind = 'llm-wiki' | 'kepano';
const wikiVersion = '4';
const builtinVersions = { 'llm-wiki': ['1','2','3',wikiVersion], kepano: ['1','2','3'] };
function isBuiltin(template:TemplateIdentity|undefined, id:BuiltinKind) {
	return template?.id === id && builtinVersions[id].includes(template.version);
}
export function isKepano(template?:TemplateIdentity) {
	return isBuiltin(template,'kepano');
}
export function isBuiltinWiki(template?:TemplateIdentity) {
	return isBuiltin(template,'llm-wiki');
}
export function sharedTemplateKind(template:TemplateIdentity):BuiltinKind|undefined {
	return template.version === '2' && (template.id === 'llm-wiki' || template.id === 'kepano') ? template.id : undefined;
}
export function kepanoBindingAssets(skeleton:Record<string,string>, version:string) {
	const historical = skeleton['README.v' + version + '.md'];
	return historical && (version === '1' || version === '2') ? {...skeleton,'README.md':historical} : skeleton;
}
export function kepanoBinding(skeleton:Record<string,string>, name:string) {
	return /\.(?:md|base)$/iu.test(name) && Object.prototype.hasOwnProperty.call(skeleton,name) && skeleton[name]!.includes('__KB_ROOT__');
}
export function kepanoTemplate(skeleton:Record<string,string>, root:string):Template {
	if (!skeleton['README.md'] || !Object.keys(skeleton).some(name=>name.startsWith('Templates/') && name.endsWith('.md')))
		throw new Error(fromEnglish('Missing built-in Kepano template','内置 Kepano 模板缺失'));
	const assets = Object.fromEntries(Object.entries(skeleton).filter(([name]) => !/^README\.v[12]\.md$/u.test(name)));
	const files = Object.entries(renderKepano(assets,root)).map(([name,text]) => ({name,bytes:new TextEncoder().encode(name.endsWith('.md') ? text.replace(/\r\n/gu,'\n') : text)}));
	files.push(builtinAttributesFile());
	return {id:'kepano',version:'3',entry:'README.md',files,folders:[],excluded:[]};
}

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
		return { name, bytes: new TextEncoder().encode(name.endsWith('.md') ? text.replace(/\r\n/gu,'\n') : text) };
	});
	files.push(builtinAttributesFile());
	return { id:'llm-wiki', version:wikiVersion, entry:'wiki/index.md', files, folders:[], excluded:[] };
}

export const excludedNames = new Set(['.git','.cache','.venv','__pycache__','node_modules']);
interface Declaration {
	id?: string; version?: string; entry?: string;
	managed?: string[]; hidden?: string[]; text?: Record<string,string[]>;
}

export function declaration(raw: string): Declaration {
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
