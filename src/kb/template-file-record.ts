import { segments } from '../fs/segments.ts';
import { tr } from '../i18n.ts';
import type {Template} from './template-core.ts';

export interface TemplateFileRecord {version:string; digests:Record<string,string>}
export const managedTextLimit=1024*1024;

export function validateManagedPath(file:string) {
	segments(file);
	if(/^(?:checks\/|kb-template\.json$|kb\.toml$|kb-manager\.json$)/iu.test(file) ||
		!/\.(?:md|base|canvas|txt|json|ya?ml|css)$/iu.test(file))
		throw new Error(tr('模板声明字段无效：','Invalid template declaration field: ')+'managedFiles.'+file);
}

export function managedText(file:string,bytes:Uint8Array) {
	try {
		if(bytes.length>managedTextLimit || bytes.includes(0))throw new Error('Invalid size or NUL byte');
		return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
	} catch {
		throw new Error(tr('受管文件需要为 UTF-8 文本，最多 1 MiB。','Managed files must contain UTF-8 text up to 1 MiB.')+' · '+file);
	}
}

export function declaredTemplateFiles(template:Template) {
	return (template.managedFiles ?? []).map(path=>{
		const file=template.files.find(file=>file.name===path);
		if(!file)throw new Error(tr('缺少声明的文件：','Missing declared file: ')+path);
		managedText(path,file.bytes);
		return file;
	});
}
