import { tr, fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gitResult } from '../git/network-native.ts';
import { guardGit } from '../git/guard.ts';
import {instanceManifestSeed} from './template-declaration.ts';
import {confirmExcludedFolders} from './template-exclusions.ts';
import {renderPack} from './template-pack.ts';
import { rebind } from './bindings.ts';
import { renameNewDirectory } from '../fs/publish.ts';
import { segments } from '../fs/paths.ts';
import { VaultDisk, digest, key, statIfPresent } from '../fs/vault.ts';
import { headOid, repository } from '../git/repository.ts';
import { commitInitialRepository, initialConfig, previewInitialRepository, reviewInitialRepository, verifyInitialRepository } from '../git/initial.ts';
import type { InitialConfig, InitialDraft, InitialPreview } from '../git/initial.ts';
import { discover, identityFile, newIdentity, readManifest, recheck, withLibraryIgnores, writeCheckKit, writeIdentity, writeTemplateFileRecord } from './catalog.ts';
import type { CheckKitRecord, Config, Library } from './catalog.ts';
import { addCreationCheckKit, assertCreationFilesTracked } from './check-kit-creation.ts';
import { builtinTemplate, folderTemplate, kepanoSource, kepanoTemplate, kepanoBinding } from './template.ts';
import type { Template } from './template.ts';
import { readManifestFile, replaceLibraryManifest } from './manifest-disk.ts';
import { registerVaultLibrary, validateLibraryLocation } from '../registry/discovery.ts';
import { assertUnreservedLibraryPath, libraryDestination } from '../registry/paths.ts';
import {declaredTemplateFiles} from './template-file-record.ts';

export interface CreateInput {
	parent: string; name: string; displayName: string; description: string; source: string;
	git?: InitialDraft;
}
export interface CreatePreview {
	input: CreateInput; location: string; template: Template; signature: string; warnings: string[];
	gitConfig: InitialConfig; git: InitialPreview;
	checkKit: CheckKitRecord;
}

export async function ancestorWarnings(disk: VaultDisk, location: string): Promise<string[]> {
	const parts = segments(location);
	const warnings = [];
	for (let i=0; i<parts.length; i++) {
		const parent = await disk.folder(parts.slice(0,i).join('/'),true);
		if (await statIfPresent(path.join(parent,identityFile))) {
			throw new Error(fromEnglish('Nested knowledge base: ','知识库不能嵌套：') + parts.slice(0,i).join('/'));
		}
		const metadata = await statIfPresent(path.join(parent,'.git'));
		if (!metadata) continue;
		if (!metadata.isDirectory()) { warnings.push(tr('祖先目录包含特殊 Git 布局，请核对父仓跟踪与忽略规则。','A parent directory has a special Git layout. Review its tracked files and ignore rules.')); continue; }
		const repo = repository(parent);
		const filepath = parts.slice(i).join('/');
		const reads = [path.join(repo.gitdir,'index'),path.join(repo.gitdir,'info'),path.join(repo.gitdir,'info','exclude')];
		for(let depth=i; depth<parts.length; depth++) reads.push(path.join(parent,...parts.slice(i,depth),'.gitignore'));
		let linked=false;
		for(const file of reads) {
			if((await statIfPresent(file))?.isSymbolicLink()){linked=true;break;}
		}
		if(linked){warnings.push(tr('父仓使用链接元数据，跟踪和忽略状态需人工核对。','The parent repository uses linked metadata. Check its tracked files and ignore rules manually.'));continue;}
		let tracked:boolean, ignored:boolean;
		try {
			tracked=(await gitResult(parent,['ls-files','-z','--',filepath])).stdout.length>0;
			ignored=(await gitResult(parent,['check-ignore','--quiet','--',filepath+'/'],{allowedExitCodes:[0,1]})).code===0;
		} catch {
			warnings.push(tr('父仓跟踪与忽略状态无法读取，请手动核对。','Unable to read parent tracking and ignore rules. Review them manually.'));
			continue;
		}
		warnings.push(tr('父仓 ','Parent repository ') + (parts.slice(0,i).join('/') || '/') + tr('：',': ') + (tracked ? tr('目标已被跟踪','destination is tracked') : ignored ? tr('目标已被忽略','destination is ignored') : tr('目标未被忽略','destination is not ignored')));
	}
	return warnings;
}

async function describeCreation(disk: VaultDisk, config: Config, input: CreateInput, skeleton: Record<string,string>) {
	if (!input.displayName.trim()) throw new Error(fromEnglish('Enter a display name','请输入显示名'));
	const location = libraryDestination(input.parent,input.name);
	const dir = await validateLibraryLocation(disk,config,location);
	if (await statIfPresent(dir)) throw new Error(fromEnglish('Destination exists: ','目标已存在：') + location);
	assertUnreservedLibraryPath((await disk.registry.read()).paths,location);
	const warnings = await ancestorWarnings(disk,location);
	const vars = {displayName:input.displayName, description:input.description, destination:location};
	let template: Template;
	if (!input.source) template = builtinTemplate(skeleton,vars);
	else if (input.source===kepanoSource) template=kepanoTemplate(skeleton,location);
	else if(input.source.startsWith('builtin:')) template=renderPack(input.source.slice(8),vars);
	else {
		if (!config.templates.includes(input.source)) throw new Error(fromEnglish('Select a registered template','请选择已登记的模板'));
		template = await folderTemplate(await disk.path(input.source),disk.configDir,vars);
	}
	const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
	for(const name of [identityFile,'.gitignore']){
		if(template.folders.some(folder=>key(folder)===name) || template.files.some(file=>key(file.name)===name && file.name!==name))
			throw new Error(tr('模板路径冲突：','Conflicting template path: ')+name);
	}
	const manifest=template.files.find(file=>file.name===identityFile);
	if(manifest && readManifest(decoder.decode(manifest.bytes)).identity)
		throw new Error(tr('模板目录含已有的知识库身份','The template folder already has a library identity'));
	const ignore=template.files.find(file=>file.name==='.gitignore');
	const bytes=new TextEncoder().encode(withLibraryIgnores(ignore?decoder.decode(ignore.bytes):''));
	if(ignore)ignore.bytes=bytes;
	else template.files.push({name:'.gitignore',bytes});
	const checkKit=await addCreationCheckKit(template,digest);
	const digests=Object.fromEntries(declaredTemplateFiles(template).map(file=>[file.name,digest(file.bytes)]));
	const signature = digest(JSON.stringify([input,template.id,template.version,template.overview,template.entry,template.folders,template.excluded,template.suggestedExcludedFolders,warnings,checkKit,
		template.files.map(file=>[file.name,digest(file.bytes)]),digests]));
	return {input,location,template,signature,warnings,checkKit,digests};
}

async function writeTemplate(dir:string,creation:Awaited<ReturnType<typeof describeCreation>>,skeleton:Record<string,string>,excludedFolders?:string[]){
	const {template,input,location}=creation;
	const manifest=newIdentity(input.displayName,input.description,{id:template.id,version:template.version},template.entry);
	manifest.schemaVersion=2;
	manifest.excludedFolders=excludedFolders;
	await fs.mkdir(path.join(dir,'.log'));
	let original='';
	for(const folder of template.folders)await fs.mkdir(path.join(dir,folder),{recursive:true});
	for(const file of template.files){
		if(file.name===identityFile){
			original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes);
			continue;
		}
		const target=path.join(dir,file.name);
		await fs.mkdir(path.dirname(target),{recursive:true});
		await fs.writeFile(target,file.bytes,{flag:'wx'});
		const offsets=template.rootSlots?.[file.name];
		if(offsets?.length){
			manifest.managed.push({path:file.name,fingerprint:digest(file.bytes),root:location,role:'template-root',offsets});
		}else if(input.source===kepanoSource && kepanoBinding(skeleton,file.name)){
			manifest.managed.push({path:file.name,fingerprint:digest(file.bytes),root:location,role:'kepano-bindings'});
		}else if((!input.source || template.overview) && file.name==='knowledge.base'){
			manifest.managed.push({path:file.name,fingerprint:digest(file.bytes),root:location,
				role:input.source?'overview-bindings':undefined});
		}
	}
	let raw=writeCheckKit(writeIdentity(original || instanceManifestSeed(template),manifest),creation.checkKit);
	if(Object.keys(creation.digests).length)
		raw=writeTemplateFileRecord(raw,{version:template.version,digests:creation.digests});
	await fs.writeFile(path.join(dir,identityFile),raw,{flag:'wx'});
	return {manifest,manifestSignature:digest(raw)};
}

function creationPaths(template:Template){
	return [...new Set([...template.files.map(file=>file.name),identityFile])].sort();
}

async function removePreviewDirectory(directory:string,owned:{dev:bigint;ino:bigint}){
	const current=await fs.lstat(directory,{bigint:true});
	if(!current.isDirectory() || current.ino!==owned.ino || current.dev!==owned.dev)
		throw new Error(tr('预览目录已变化，保留目录以便检查：','The preview directory changed and was retained for review: ')+directory);
	await fs.rm(directory,{recursive:true});
}

export async function previewCreate(disk: VaultDisk, config: Config, input: CreateInput, skeleton: Record<string,string>): Promise<CreatePreview> {
	const creation=await describeCreation(disk,config,input,skeleton),gitConfig=await initialConfig(input.git);
	const temporary=await fs.mkdtemp(path.join(await fs.realpath(disk.root),'.kb-preview-'));
	const owned=await fs.lstat(temporary,{bigint:true});
	try{
		await writeTemplate(temporary,creation,skeleton);
		const git=await previewInitialRepository(temporary,creationPaths(creation.template),gitConfig);
		assertCreationFilesTracked(creation.template,git.staged);
		return {...creation,gitConfig,git};
	}finally{await removePreviewDirectory(temporary,owned);}
}

type BeforeRegistration=(manifest:ReturnType<typeof newIdentity>)=>Promise<void>;

export async function createLibrary(disk: VaultDisk, config: Config, preview: CreatePreview, skeleton: Record<string,string>,beforeRegistration?:BeforeRegistration,excludedFolders:readonly string[]=[]) {
	await disk.registry.assertWritable();
	const fresh=await describeCreation(disk,config,preview.input,skeleton);
	if (fresh.signature !== preview.signature) throw new Error(fromEnglish('Template changed. Preview again.','模板已变化，请重新预览。'));
	const confirmedFolders=confirmExcludedFolders(fresh.template.suggestedExcludedFolders,excludedFolders);
	const gitConfig=await initialConfig(fresh.input.git);
	if(JSON.stringify(gitConfig)!==JSON.stringify(preview.gitConfig))
		throw new Error(tr('Git 配置已变化，请重新预览。','Git configuration changed. Preview again.'));
	const parent = await disk.folder(fresh.input.parent,true);
	if (fresh.input.parent) await fs.mkdir(parent,{recursive:true});
	await disk.folder(fresh.input.parent);
	const temporary = await fs.mkdtemp(path.join(parent,'.kb-create-'));
	const {template,location}=fresh,paths=creationPaths(template);
	let receipt:CreationReceipt|undefined;
	try {
		const owned=await fs.lstat(temporary,{bigint:true}),written=await writeTemplate(temporary,fresh,skeleton,confirmedFolders);
		const git=await previewInitialRepository(temporary,paths,gitConfig);
		if(JSON.stringify(git)!==JSON.stringify(preview.git))
			throw new Error(tr('首提交内容已变化，请重新预览。','Initial commit contents changed. Preview again.'));
		if(JSON.stringify(await ancestorWarnings(disk,location))!==JSON.stringify(fresh.warnings))
			throw new Error(tr('父目录状态已变化，请重新预览。','The parent directory state changed. Preview again.'));
		await disk.registry.assertWritable();
		for (let attempt = 0; ; attempt++) {
			const destination = await validateLibraryLocation(disk,config,location);
			assertUnreservedLibraryPath((await disk.registry.read()).paths,location);
			if (await statIfPresent(destination)) throw new Error(fromEnglish('Destination exists: ','目标已存在：') + location);
			try {
				await renameNewDirectory(temporary,destination);
				receipt={path:destination,owned,preview,...written};
				break;
			}
			catch (error) {
				if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 4) throw error;
				await delay(50 * 2 ** attempt);
			}
		}
		return await finishCreation(disk,config,receipt,{git:preview.git,head:''},beforeRegistration);
	} catch(error) {
		if(receipt)throw new CreationInterrupted(error,receipt);
		throw new Error(String(error)+tr('。未发布目录已保留，可检查后重试：','. The unpublished directory was retained for review before retrying: ')+temporary);
	}
}

interface CreationReceipt {
	path:string; owned:{dev:bigint;ino:bigint}; preview:CreatePreview;
	manifest:ReturnType<typeof newIdentity>; manifestSignature:string; head?:string;
}
interface CreationReview { git:InitialPreview; head:string }

export class CreationInterrupted extends Error {
	readonly receipt:CreationReceipt;
	constructor(cause:unknown,receipt:CreationReceipt){
		super(String(cause));
		this.receipt=receipt;
	}
}

async function verifyCreationContents(disk:VaultDisk,receipt:CreationReceipt){
	const {preview,path:dir,owned,manifestSignature}=receipt;
	const changed=()=>new Error(tr('刚创建的目录或文件已变化，请先检查。','The new directory or its files changed. Review them before continuing.')+' · '+dir);
	const current=await fs.lstat(await disk.path(preview.location),{bigint:true});
	if(!current.isDirectory() || current.dev!==owned.dev || current.ino!==owned.ino)throw changed();
	await guardGit(dir);
	for(const folder of preview.template.folders){
		if(!(await statIfPresent(path.join(dir,folder)))?.isDirectory())throw changed();
	}
	const verify=async(name:string,expected:string)=>{
		const file=path.join(dir,name);
		if(!(await statIfPresent(file))?.isFile() || digest(await fs.readFile(file))!==expected)throw changed();
	};
	await verify(identityFile,manifestSignature);
	for(const file of preview.template.files){
		if(file.name!==identityFile)await verify(file.name,digest(file.bytes));
	}
}

export async function reviewInterruptedCreation(disk:VaultDisk,receipt:CreationReceipt):Promise<CreationReview>{
	await verifyCreationContents(disk,receipt);
	const {path:dir,preview}=receipt;
	const head=await headOid(dir);
	if(receipt.head!==undefined && receipt.head!==head)throw new Error(tr('刚创建的首提交已变化。','The initial commit changed.'));
	if(head){
		await verifyInitialRepository(dir,head,preview.git);
		return {head,git:preview.git};
	}
	const git=await reviewInitialRepository(dir,creationPaths(preview.template),preview.gitConfig);
	assertCreationFilesTracked(preview.template,git.staged);
	return {head,git};
}

async function finishCreation(disk:VaultDisk,config:Config,receipt:CreationReceipt,review:CreationReview,beforeRegistration?:BeforeRegistration){
	const {path:dir,manifest,preview}=receipt,{location}=preview;
	await verifyCreationContents(disk,receipt);
	await ancestorWarnings(disk,location);
	if((await discover(disk,config)).some(lib=>lib.identity?.id===manifest.id && lib.location!==location))
		throw new Error(tr('相同身份的知识库已存在','A library with the same ID already exists'));
	await disk.registry.assertWritable();
	let {head}=review;
	if(head)await verifyInitialRepository(dir,head,review.git);
	else{
		receipt.preview={...preview,git:review.git};
		head=await commitInitialRepository(dir,creationPaths(preview.template),review.git);
	}
	receipt.head=head;
	await beforeRegistration?.(manifest);
	await registerVaultLibrary(disk,config,location);
	const {branch,message,identity,origin}=review.git;
	return {manifest,location,path:dir,head,branch,message,identity,origin};
}

export async function resumeCreation(disk:VaultDisk,config:Config,receipt:CreationReceipt,review:CreationReview,beforeRegistration?:BeforeRegistration){
	try{return await finishCreation(disk,config,receipt,review,beforeRegistration);}
	catch(error){throw new CreationInterrupted(error,receipt);}
}

export async function legacyBinding(disk: VaultDisk, lib: Library) {
	if (lib.mapping?.wiki !== 'wiki') return undefined;
	const file = await disk.path(lib.location + '/knowledge.base');
	if (!(await statIfPresent(file))?.isFile()) return undefined;
	const bytes = await fs.readFile(file);
	try {
		const result = rebind(bytes.toString('utf8'), lib.location, lib.location);
		if (result.manual.length) return undefined;
		return digest(bytes);
	} catch { return undefined; }
}

export async function adoptionWarnings(disk:VaultDisk,lib:Library) {
	const warnings=await ancestorWarnings(disk,lib.location);
	if(lib.git==='local' && (await gitResult(await disk.path(lib.location),['ls-files','-z','--',identityFile])).stdout.length)
		warnings.push(tr('Git 已跟踪 kb.toml。接管会修改工作区清单，保留现有暂存区和历史。','Git tracks kb.toml. Adoption edits the working tree manifest and preserves the index and history.'));
	return warnings;
}

export async function adopt(disk: VaultDisk, config: Config, preview: Library, confirmedWarnings: string[], bindingHash?:string) {
	const lib = await recheck(disk,config,preview);
	if (lib.identity || !lib.signature) throw new Error(fromEnglish('Select a valid legacy knowledge base','请选择有效的旧知识库'));
	if (JSON.stringify(await adoptionWarnings(disk,lib)) !== JSON.stringify(confirmedWarnings)) throw new Error(fromEnglish('Repository state changed. Preview adoption again.','仓库状态已变化，请重新预览接管。'));
	const manifest = newIdentity(path.posix.basename(lib.location),'',{id:'unknown',version:'unknown'},lib.mapping?.index);
	if (bindingHash) {
		if(await legacyBinding(disk,lib)!==bindingHash)throw new Error(tr('旧库绑定字段已变化','The legacy library binding changed'));
		manifest.managed.push({path:'knowledge.base',root:lib.location,fingerprint:bindingHash,role:'overview-bindings'});
	}
	const target = await disk.path(lib.location+'/'+identityFile);
	const {raw}=await readManifestFile(target);
	await disk.registry.assertWritable();
	await replaceLibraryManifest(disk,lib.location,lib.signature,writeIdentity(raw,manifest));
	await registerVaultLibrary(disk,config,lib.location);
	return manifest;
}
