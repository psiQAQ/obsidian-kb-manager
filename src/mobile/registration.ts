import {tr} from '../i18n.ts';
import {identityFile,readManifest,writeIdentity} from '../kb/identity-core.ts';
import type {Identity} from '../kb/identity-core.ts';
import type {Mapping} from '../kb/mapping.ts';
import type {GitPreferences} from '../preferences.ts';
import {amendRegistry,compareRegistryPaths,registryIgnoreFor,validateLibraryPath,validateRegistryPath,vaultParent,withIgnoreRule} from '../registry/paths.ts';
import type {PluginDataRegistry} from '../registry/plugin-data.ts';
import {checkSpelling,children,key,replaceText} from './disk.ts';
import type {Disk} from './disk.ts';

export interface Catalog {disk:Disk;configDir:string;registry:PluginDataRegistry;parents:string[];templates:string[]}
export interface Library {
	location:string;identity?:Identity;mapping?:Mapping;preferences?:Partial<GitPreferences>;manifest?:string;
	legacy?:boolean;missing?:boolean;problem?:string;duplicate?:boolean;
}

export async function nested(ctx:Catalog,path:string){
	if(await ctx.disk.stat(identityFile))return true;
	if(!path)return false;
	let dir='';
	for(const part of path.split('/')){
		dir=dir?dir+'/'+part:part;
		if(await ctx.disk.stat(dir+'/'+identityFile))return true;
	}
	return false;
}

export function libraryPath(ctx:Catalog,path:string){
	return validateLibraryPath(path,ctx.configDir,ctx.templates);
}

export async function readMobileRegistry(ctx:Catalog){
	return (await ctx.registry.read()).paths;
}

export async function previewMobileRegistryIgnore(ctx:Catalog){
	await checkSpelling(ctx.disk,'.git');
	if(!await ctx.disk.stat('.git'))return undefined;
	const path='.gitignore';
	await checkSpelling(ctx.disk,path);
	const before=(await ctx.disk.stat(path))?await ctx.disk.read(path):undefined;
	const rule=registryIgnoreFor(ctx.configDir);
	return {path,before,after:withIgnoreRule(before??null,rule),rule};
}

type IgnorePreview=Awaited<ReturnType<typeof previewMobileRegistryIgnore>>;
export function registryIgnoreLines(plan:IgnorePreview){
	return plan && plan.before!==plan.after?[tr('仓库根目录 .gitignore · ','Vault root .gitignore · ')+plan.rule]:[];
}

export async function applyMobileRegistryIgnore(ctx:Catalog,plan:IgnorePreview,allowApplied=false){
	const current=await previewMobileRegistryIgnore(ctx);
	if(allowApplied && plan && current?.before===plan.after && current.after===plan.after)return;
	if(JSON.stringify(current)!==JSON.stringify(plan))throw new Error(tr('仓库的 Git 忽略规则已变化，请重新预览','Vault Git ignore rules changed. Review them again.'));
	if(plan)await replaceText(ctx.disk,plan.path,plan.before,plan.after);
}

type RegistryChange=Parameters<typeof amendRegistry>[1];
export async function updateMobileRegistry(ctx:Catalog,change:RegistryChange):Promise<void>{
	await ctx.registry.update(paths=>amendRegistry(paths,change,ctx.configDir));
}

async function inspect(ctx:Catalog,location:string):Promise<Library>{
	const lib:Library={location};
	try{
		libraryPath(ctx,location);
		await checkSpelling(ctx.disk,location,true);
		const status=await ctx.disk.stat(location);
		if(!status)return {...lib,missing:true};
		if(status.type!=='folder')throw new Error(tr('路径已被文件占用','A file occupies the library path'));
		const parent=vaultParent(location);
		if(await nested(ctx,parent))throw new Error(tr('知识库不能嵌套','Knowledge bases cannot be nested'));
		const path=location+'/'+identityFile;
		await checkSpelling(ctx.disk,path);
		if(!(await ctx.disk.stat(path)))return {...lib,missing:true};
		const manifest=await ctx.disk.read(path),{identity,mapping,preferences}=readManifest(manifest);
		if(!identity && !mapping)throw new Error(tr('清单没有知识库身份或目录映射','The manifest has no library identity or path mapping'));
		return {...lib,identity,mapping,preferences,manifest,legacy:!identity};
	}catch(e){return {...lib,problem:String(e)};}
}

export async function discoverMobile(ctx:Catalog){
	const entries=await Promise.all((await readMobileRegistry(ctx)).map(path=>inspect(ctx,path)));
	const counts=new Map<string,number>();
	for(const lib of entries)if(lib.identity)counts.set(lib.identity.id,(counts.get(lib.identity.id)??0)+1);
	for(const lib of entries)if(lib.identity)lib.duplicate=counts.get(lib.identity.id)!>1;
	return entries;
}

export async function verifyLibrary(ctx:Catalog,expected:Library,write=false){
	const lib=(await discoverMobile(ctx)).find(l=>l.location===expected.location);
	if(!lib?.identity || lib.problem || lib.duplicate || lib.identity.id!==expected.identity?.id || (write && lib.identity.archived))
		throw new Error(tr('知识库身份或状态已变化，请刷新','Library identity or state changed. Refresh the manager.'));
	return lib.identity;
}

export async function selectMobileManifest(ctx:Catalog,file:string){
	const end='/'+identityFile;
	if(!file.endsWith(end))throw new Error(tr('请选择知识库根目录中的 kb.toml','Select kb.toml at the library root'));
	const lib=await inspect(ctx,file.slice(0,-end.length));
	if(!lib.manifest)throw new Error(lib.problem??tr('未找到清单','Manifest not found'));
	return lib;
}

export async function scanMobile(ctx:Catalog,folder:string){
	const excluded=(dir:string)=>ctx.templates.some(template=>(key(dir)+'/').startsWith(key(template)+'/'));
	if(folder){
		validateRegistryPath(folder,ctx.configDir);
		await checkSpelling(ctx.disk,folder,true);
		if((await ctx.disk.stat(folder))?.type!=='folder')throw new Error(tr('扫描目录不存在','The selected folder does not exist'));
		if(excluded(folder))throw new Error(tr('不能扫描模板目录','Template folders cannot be scanned')+' · '+folder);
		if(await nested(ctx,vaultParent(folder)))throw new Error(tr('知识库不能嵌套','Knowledge bases cannot be nested'));
	}else if(await ctx.disk.stat(identityFile)){
		throw new Error(tr('仓库根目录的 kb.toml 不能登记为子库','A kb.toml at the Vault root cannot register as a child library'));
	}
	const results:Library[]=[];
	async function scan(dir:string){
		if(dir && excluded(dir))return;
		const entries=await children(ctx.disk,dir);
		const prefix=dir?dir+'/':'';
		if(dir && entries.files.includes(prefix+identityFile)){results.push(await inspect(ctx,dir));return;}
		for(const sub of entries.folders.sort(compareRegistryPaths)){
			const name=sub.slice(prefix.length);
			if(!name.startsWith('.') && key(name)!=='node_modules' && key(sub)!==key(ctx.configDir))await scan(sub);
		}
	}
	await scan(folder);
	return results;
}

export async function registerMobile(ctx:Catalog,expected:Library[],replace?:string,ignore?:IgnorePreview){
	await ctx.registry.assertWritable();
	const snapshot=await ctx.registry.read();
	if(replace){
		const previous=(await discoverMobile(ctx)).find(entry=>entry.location===replace);
		if(!previous?.missing)throw new Error(tr('原登记路径已变化','The previous registration has changed'));
	}
	for(const lib of expected){
		const current=await inspect(ctx,lib.location);
		if(!current.manifest || current.manifest!==lib.manifest)throw new Error(tr('清单已变化，请重新预览','Manifest changed. Review it again.'));
	}
	const next=amendRegistry(snapshot.paths,{add:expected.map(lib=>lib.location),remove:replace?[replace]:undefined},ctx.configDir);
	await ctx.registry.write(snapshot.raw,next,()=>applyMobileRegistryIgnore(ctx,ignore));
}

export async function assignMobileCopyId(ctx:Catalog,expected:Library,original:string,newId:string){
	const id=expected.identity?.id,entries=await discoverMobile(ctx);
	const copy=entries.find(entry=>entry.location===expected.location),source=entries.find(entry=>entry.location===original);
	if(!id || !copy?.identity || !copy.manifest || copy.manifest!==expected.manifest || copy.location===source?.location || source?.identity?.id!==id ||
		entries.some(entry=>entry.identity?.id===newId.toLowerCase()))throw new Error(tr('重复登记状态已变化','The duplicate registrations changed'));
	await replaceText(ctx.disk,copy.location+'/'+identityFile,copy.manifest,writeIdentity(copy.manifest,{...copy.identity,id:newId}));
}
