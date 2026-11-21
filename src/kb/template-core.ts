import {builtinAttributesFile} from '../git/markdown-attributes.ts';
import { fromEnglish } from '../i18n.ts';
import {declaration} from './template-declaration.ts';
export { declaration } from './template-declaration.ts';
import { renderKepano } from './kepano.ts';
import { parseDocument, isScalar } from 'yaml';

export interface TemplateFile { name: string; bytes: Uint8Array }
export interface Template {
	id: string; version: string; entry?: string;
	paths?:Record<string,string>; rootSlots?: Record<string, number[]>; overview?: boolean; files: TemplateFile[]; folders: string[]; excluded: string[];
}
export interface Variables { displayName: string; description: string; destination: string }

export const kepanoSource = 'builtin:kepano';
type TemplateIdentity = Pick<Template,'id'|'version'>;
export type BuiltinKind = 'llm-wiki' | 'kepano';
const wikiVersion = '6';
const builtinVersions = { 'llm-wiki': ['1','2','3','4','5',wikiVersion], kepano: ['1','2','3','4','5'] };
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
function bundledText(name:string,text:string){
	return /\.(?:md|base|canvas)$/iu.test(name) || name==='kb-template.json' || /^checks\/[^/]+\.mjs$/u.test(name) ? text.replace(/\r\n/gu,'\n') : text;
}
export function kepanoTemplate(skeleton:Record<string,string>, root:string):Template {
	if (!skeleton['README.md'] || !Object.keys(skeleton).some(name=>name.startsWith('Templates/') && name.endsWith('.md')))
		throw new Error(fromEnglish('Missing built-in Kepano template','内置 Kepano 模板缺失'));
	const assets = Object.fromEntries(Object.entries(skeleton).filter(([name]) => !/^README\.v[12]\.md$/u.test(name)));
	const files = Object.entries(renderKepano(assets,root)).map(([name,text]) => ({name,bytes:new TextEncoder().encode(bundledText(name,text))}));
	files.push(builtinAttributesFile());
	return {id:'kepano',version:'5',entry:'README.md',files,folders:[],excluded:[]};
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
	const paths=skeleton['kb-template.json']?declaration(skeleton['kb-template.json']).paths:undefined;
	const files = Object.entries(skeleton).filter(([name])=>name!=='kb.toml' || !paths).map(([name, text]) => {
		if (name === 'README.md') text = text.replace(/\{\{kb_name\}\}|\{\{description\}\}/gu,
			token => token === '{{kb_name}}' ? vars.displayName : vars.description);
		if (name === 'knowledge.base') text = renderBase(text, vars.destination);
		return { name, bytes: new TextEncoder().encode(bundledText(name,text)) };
	});
	files.push(builtinAttributesFile());
	return { id:'llm-wiki', version:wikiVersion, paths, entry:'wiki/index.md', files, folders:[], excluded:[] };
}

export const excludedNames = new Set(['.git','.obsidian','.log','.cache','.venv','__pycache__','node_modules']);
