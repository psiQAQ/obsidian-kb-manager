import {attributesPath,attributesWithCheckKit} from '../git/markdown-attributes.ts';
import {tr} from '../i18n.ts';
import {registryKey} from '../registry/paths.ts';
import {checkKitFiles,checkKitVersion} from './check-kit.ts';
import {checkInstructions,composeCheckReadme,readmePath} from './check-readme.ts';
import {identityFile,parseCheckKit,readManifest} from './identity-core.ts';
import type {CheckKitRecord} from './identity-core.ts';
import {declaration} from './template-declaration.ts';
import type {CheckDeclaration} from './template-declaration.ts';
import type {Template} from './template-core.ts';

const declarationPath='kb-template.json';
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const encoder=new TextEncoder();

function checkReadme(bytes:Uint8Array|undefined,checks:CheckDeclaration[]) {
	let original:string|undefined;
	try {
		original=bytes?decoder.decode(bytes):undefined;
		if(original?.includes('\0'))throw new Error();
	} catch {
		throw new Error(tr('无法将检验说明写入非 UTF-8 文本：','Cannot add check instructions to a non-UTF-8 text file: ')+readmePath);
	}
	return encoder.encode(composeCheckReadme(original,checkInstructions(checks)));
}

export async function addCreationCheckKit(template:Template,hash:(content:Uint8Array)=>string|Promise<string>):Promise<CheckKitRecord> {
	const files=checkKitFiles();
	const kit=Object.entries(files).map(([name,content])=>({name,bytes:encoder.encode(content)}));
	const locations=new Map<string,{name:string;file:boolean}>();
	function index(name:string,file:boolean) {
		const parts=name.split('/');
		for(let i=1;i<=parts.length;i++) {
			const path=parts.slice(0,i).join('/'), key=registryKey(path);
			const record=locations.get(key);
			const leafFile=i===parts.length && file;
			if(record && (path!==record.name || leafFile!==record.file))
				throw new Error(tr('模板路径冲突：','Conflicting template path: ')+path);
			locations.set(key,{name:path,file:leafFile});
		}
	}
	for(const folder of template.folders)index(folder,false);
	for(const file of template.files)index(file.name,true);
	const outputFiles=new Map(template.files.map(file=>[file.name,file]));
	const collision=(name:string)=>new Error(tr('模板路径与通用检验套件冲突：','A template path conflicts with the common check kit: ')+name);
	for(const name of [readmePath,attributesPath]){
		const existing=locations.get(registryKey(name));
		if(existing && (existing.name!==name || !existing.file))throw collision(name);
		index(name,true);
	}
	const additions=kit.filter(({name,bytes})=>{
		const existing=locations.get(registryKey(name));
		if(!existing){
			index(name,true);
			return true;
		}
		const current=outputFiles.get(name)?.bytes;
		if(!current || current.length!==bytes.length || !current.every((byte,i)=>byte===bytes[i]))throw collision(name);
		return false;
	});
	const manifest=outputFiles.get(identityFile);
	if(manifest && readManifest(decoder.decode(manifest.bytes)).checkKit)
		throw new Error(tr('模板的 kb.toml 已包含通用检验套件记录','The template kb.toml already has a common check kit record'));
	const readme=outputFiles.get(readmePath), spec=outputFiles.get(declarationPath);
	const checks=spec?declaration(decoder.decode(spec.bytes)).checks??[]:[];
	const attributes=outputFiles.get(attributesPath);
	const policy=attributesWithCheckKit(attributes?decoder.decode(attributes.bytes):undefined);
	if(!policy)throw new Error(tr('模板包含不支持的 Git 属性文件：','The template has an unsupported Git attributes file: ')+attributesPath);
	const readmeBytes=checkReadme(readme?.bytes,checks), attributesBytes=encoder.encode(policy);
	const digests=Object.fromEntries(await Promise.all(kit.map(async ({name,bytes}):Promise<[string,string]>=>[name,await hash(bytes)])));
	const record=parseCheckKit({protocol:1,version:checkKitVersion,digests});
	if(readme)readme.bytes=readmeBytes;
	else template.files.push({name:readmePath,bytes:readmeBytes});
	if(attributes)attributes.bytes=attributesBytes;
	else template.files.push({name:attributesPath,bytes:attributesBytes});
	template.files.push(...additions);
	return record;
}

export function assertCreationFilesTracked(template:Template,staged:readonly string[]) {
	const paths=new Set(staged);
	const missing=template.files.map(file=>file.name).filter(name=>
		(name===readmePath || name===attributesPath || name===declarationPath || name.startsWith('checks/')) && !paths.has(name));
	if(missing.length)
		throw new Error(tr('模板清单、README、Git 属性和检验文件必须纳入首提交。请检查 Git 忽略规则：','The template declaration, README, Git attributes and check files must be tracked in the initial commit. Review the ignore rules: ')+missing.join(', '));
}
