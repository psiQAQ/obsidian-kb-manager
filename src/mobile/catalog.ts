import {renderPack} from '../kb/template-pack.ts';
import {instanceManifestSeed,verifyDeclaration} from '../kb/template-declaration.ts';
import {instanceText} from '../kb/instance-text.ts';
import {tr} from '../i18n.ts';
import {segments} from '../fs/segments.ts';
import {identityFile,readManifest,withLibraryIgnores,writeIdentity} from '../kb/identity-core.ts';
import type {Identity} from '../kb/identity-core.ts';
import {builtinTemplate,kepanoSource,kepanoTemplate,kepanoBinding,declaration,excludedNames,renderBase} from '../kb/template-core.ts';
import type {Template,Variables} from '../kb/template-core.ts';
import {buffer,bytes,checkSpelling,children,decode,ensureFolder,hash,key,relative,settingsPaths} from './disk.ts';
import {applyMobileRegistryIgnore,libraryPath,nested,previewMobileRegistryIgnore,readMobileRegistry,updateMobileRegistry} from './registration.ts';
import type {Catalog} from './registration.ts';
import {initializeMobileGit,previewInitialFiles,verifyInitialCommit} from './create-git.ts';
import {effectiveAuthor} from './git.ts';
import type {Author} from './git.ts';
import {endpoint} from './http.ts';

export {discoverMobile,verifyLibrary} from './registration.ts';
export type {Catalog,Library} from './registration.ts';
export interface Templates {wiki:Record<string,string>;kepano:Record<string,string>}
export interface Creation {parent:string;name:string;displayName:string;description:string;source:string;author:Author;origin?:string}

export function newIdentity(displayName:string,description='',template={id:'unknown',version:'unknown'},entry?:string,id:string=crypto.randomUUID()):Identity{
	return {schemaVersion:1,id,displayName,description,archived:false,template,entry,managed:[]};
}

async function creationLocation(ctx:Catalog,parent:string,name:string){
	settingsPaths(ctx.parents,ctx.templates,ctx.configDir);
	if(!ctx.parents.includes(parent) || segments(name).length!==1 || await nested(ctx,parent))throw new Error(tr('请选择有效的目标目录','Choose a valid destination'));
	const path=libraryPath(ctx,parent+'/'+name);
	await checkSpelling(ctx.disk,path);
	return path;
}
export async function destination(ctx:Catalog,parent:string,name:string){
	const path=await creationLocation(ctx,parent,name);
	if(await ctx.disk.stat(path))throw new Error(tr('目标已存在','Destination already exists')+': '+path);
	return path;
}
async function directoryTemplate(ctx:Catalog,root:string,vars:Variables):Promise<Template>{
	if(!ctx.templates.includes(root))throw new Error(tr('请选择已登记的模板','Select a registered template'));
	await checkSpelling(ctx.disk,root);
	const specPath=root+'/kb-template.json';
	const spec=(await ctx.disk.stat(specPath))?declaration(await ctx.disk.read(specPath)):{};
	const files:Template['files']=[],folders:string[]=[],excluded:string[]=[],sourceFiles:string[]=[];
	const rootSlots:Record<string,number[]>={};
	async function scan(dir:string){
		const list=await children(ctx.disk,dir);
		for(const path of [...list.files,...list.folders].sort()){
			const name=path.slice(dir.length+1),file=path.slice(root.length+1);
			if(key(name)==='kb-manager.json')throw new Error(tr('模板含知识库身份文件','Template contains a library identity')+': '+file);
			if(key(name)===key(ctx.configDir) || excludedNames.has(key(name)) ||
				(name.startsWith('.') && !['.gitignore','.gitkeep'].includes(name) && !spec.hidden?.includes(file))){excluded.push(file);continue;}
			relative(file,ctx.configDir);
			if(list.folders.includes(path)){folders.push(file);await scan(path);continue;}
			let data:Uint8Array=new Uint8Array(await ctx.disk.readBinary(path));
			if(key(name)===identityFile && (file!==identityFile || readManifest(decode(data)).identity))
				throw new Error(tr('模板含知识库身份文件','Template contains a library identity')+': '+file);
			sourceFiles.push(file+':'+await hash(data));
			const fields=spec.text?.[file];
			if(fields){
				const rendered=instanceText(file,decode(data),fields,vars);
				data=bytes(rendered.content);
				if(rendered.offsets.length)rootSlots[file]=rendered.offsets;
			}
			if(file==='knowledge.base' && spec.managed?.length)data=bytes(renderBase(decode(data),vars.destination));
			files.push({name:file,bytes:data});
		}
	}
	await scan(root);
	verifyDeclaration(spec,files.map(file=>file.name),folders);
	return {id:spec.id??'folder',version:spec.version??await hash(JSON.stringify([spec,folders,sourceFiles])),files,folders,rootSlots,paths:spec.paths,excluded,entry:spec.entry,overview:!!spec.managed?.length};
}
export async function createPreview(ctx:Catalog,input:Creation,assets:Templates,id:string=crypto.randomUUID()){
	const location=await destination(ctx,input.parent,input.name);
	if(!input.displayName.trim())throw new Error(tr('请填写显示名','Enter a display name'));
	const address=input.origin?.trim(),origin=address?endpoint(address):undefined;
	const author=effectiveAuthor(input.author,{name:'',email:''});
	input={...input,author,origin};
	const vars={...input,destination:location};
	const template=input.source===kepanoSource?kepanoTemplate(assets.kepano,location):input.source.startsWith('builtin:')?renderPack(input.source.slice(8),vars):input.source?
		await directoryTemplate(ctx,input.source,vars):builtinTemplate(assets.wiki,vars);
	for(const name of [identityFile,'.gitignore'])if(template.folders.some(folder=>key(folder)===name) ||
		template.files.some(file=>key(file.name)===name && file.name!==name))
		throw new Error(tr('模板路径冲突','Conflicting template path')+' · '+name);
	const ignore=template.files.find(file=>file.name==='.gitignore');
	const ignoreBytes=bytes(withLibraryIgnores(ignore?decode(ignore.bytes):''));
	if(ignore)ignore.bytes=ignoreBytes;else template.files.push({name:'.gitignore',bytes:ignoreBytes});
	const files=await previewInitialFiles({root:location,disk:ctx.disk,configDir:ctx.configDir},template.files);
	const staged=new Set(files.map(file=>file.name));
	if(template.files.some(file=>(file.name==='kb-template.json' || file.name.startsWith('checks/')) && !staged.has(file.name)))throw new Error(tr('模板清单与专项脚本必须可提交','Template declarations and checks must be tracked'));
	const registryIgnore=await previewMobileRegistryIgnore(ctx);
	const signature=await hash(JSON.stringify([input,id,template.id,template.version,template.folders,template.excluded,template.entry,template.overview,files.map(file=>file.name),
		await Promise.all(template.files.map(async f=>[f.name,await hash(f.bytes)]))]));
	return {location,input,id,template,signature,registryIgnore,initial:{files,author,origin}};
}

export async function scratch(ctx:Catalog,parent:string){
	if(!ctx.parents.includes(parent) || await nested(ctx,parent))throw new Error(tr('无效的父目录','Invalid parent'));
	await checkSpelling(ctx.disk,parent);await ensureFolder(ctx.disk,parent);
	const dir=parent+'/.kb-tmp-'+crypto.randomUUID();
	if(await ctx.disk.stat(dir))throw new Error(tr('临时目录冲突','Temporary folder collision'));
	await ctx.disk.mkdir(dir);
	return dir;
}

// DataAdapter.copy is documented to reject existing destinations, even when a
// concurrent writer wins after our preview. Publish the identity file last.
export async function publish(ctx:Catalog,src:string,parent:string,name:string,verify?:()=>Promise<void>){
	const dest=await destination(ctx,parent,name);
	const files:[source:string,target:string][]=[],folders=[dest];
	await ctx.disk.mkdir(dest);
	async function copyFile(file:string){
		const target=dest+file.slice(src.length);
		await ctx.disk.copy(file,target);
		files.push([file,target]);
	}
	async function copy(dir:string){
		const data=await children(ctx.disk,dir);
		for(const sub of data.folders){
			const target=dest+sub.slice(src.length);
			if(await ctx.disk.stat(target))throw new Error(tr('目录冲突','Directory collision')+': '+target);
			await ctx.disk.mkdir(target);folders.push(target);await copy(sub);
		}
		for(const file of data.files)if(file!==src+'/'+identityFile)await copyFile(file);
	}
	try{
		await copy(src);
		if(await ctx.disk.stat(src+'/'+identityFile))await copyFile(src+'/'+identityFile);
		await verify?.();
	}catch(error){
		// Remove only paths we successfully created, keeping pre-existing or independently changed data.
		for(const [source,target] of files.reverse())try{
			if((await ctx.disk.stat(target))?.type==='file' &&
				await hash(new Uint8Array(await ctx.disk.readBinary(target)))===await hash(new Uint8Array(await ctx.disk.readBinary(source))))await ctx.disk.remove(target);
		}catch{/* Preserve files we cannot verify or remove. */}
		for(const folder of folders.reverse())try{await ctx.disk.rmdir(folder,false);}catch{/* Preserve nonempty or unavailable folders. */}
		if(await ctx.disk.stat(dest))throw new Error(String(error)+tr('。目标中仍有文件，请检查：','. Files remain at the destination. Inspect: ')+dest);
		throw error;
	}
}
export async function instantiate(ctx:Catalog,confirmed:Awaited<ReturnType<typeof createPreview>>,assets:Templates,beforeRegistration?:()=>Promise<void>){
	await ctx.registry.assertWritable();
	const {input,initial,template}=confirmed;
	const location=await creationLocation(ctx,input.parent,input.name),store={root:location,disk:ctx.disk,configDir:ctx.configDir};
	const identity=newIdentity(input.displayName,input.description,{id:template.id,version:template.version},template.entry,confirmed.id);
	identity.schemaVersion=2;
	for(const file of template.files){
		const offsets=template.rootSlots?.[file.name];
		if(offsets?.length)identity.managed.push({path:file.name,root:location,fingerprint:await hash(file.bytes),role:'template-root',offsets});
		else if(input.source===kepanoSource && kepanoBinding(assets.kepano,file.name))
			identity.managed.push({path:file.name,root:location,fingerprint:await hash(file.bytes),role:'kepano-bindings'});
		else if((!input.source || template.overview) && file.name==='knowledge.base')
			identity.managed.push({path:file.name,root:location,fingerprint:await hash(file.bytes),role:input.source?'overview-bindings':undefined});
	}
	const asset=template.files.find(file=>file.name===identityFile),manifest=writeIdentity(asset?decode(asset.bytes):instanceManifestSeed(template),identity);
	const manifestPath=location+'/'+identityFile;
	const verified=async()=>{
		if(await ctx.disk.read(manifestPath)!==manifest)throw new Error(tr('目标清单已变化','The destination manifest changed')+' · '+manifestPath);
		return verifyInitialCommit(store,initial);
	};
	const protect=()=>applyMobileRegistryIgnore(ctx,confirmed.registryIgnore,true);
	const register=async()=>{
		try{
			await beforeRegistration?.();
			await updateMobileRegistry(ctx,{add:[location]});
			if(!(await readMobileRegistry(ctx)).includes(location))throw new Error(tr('登记写入无法验证','Could not verify the registry update'));
		}catch(error){throw new Error(String(error)+tr('。初始提交已创建，请重试登记：','. The initial commit is ready. Retry registration for: ')+location);}
	};
	const occupant=await ctx.disk.stat(location);
	if(occupant){
		if(occupant.type!=='folder')throw new Error(tr('目标已存在','Destination already exists')+': '+location);
		await checkSpelling(ctx.disk,manifestPath);
		if((await ctx.disk.stat(manifestPath))?.type!=='file' || await ctx.disk.read(manifestPath)!==manifest)
			throw new Error(tr('目标已存在','Destination already exists')+': '+location);
		const receipt=await verified();
		await protect();await register();
		return {identity,location,...receipt};
	}
	const fresh=await createPreview(ctx,input,assets,confirmed.id);
	if(fresh.signature!==confirmed.signature)throw new Error(tr('模板已变化，请重新预览','Template changed. Review it again.'));
	const temp=await scratch(ctx,input.parent);
	try{
		await ensureFolder(ctx.disk,temp+'/.log');
		for(const sub of template.folders)await ensureFolder(ctx.disk,temp+'/'+relative(sub,ctx.configDir));
		for(const file of template.files){
			if(file.name===identityFile)continue;
			const loc=temp+'/'+relative(file.name,ctx.configDir);
			await ensureFolder(ctx.disk,loc.slice(0,loc.lastIndexOf('/')));await ctx.disk.writeBinary(loc,buffer(file.bytes));
		}
		await ctx.disk.write(temp+'/'+identityFile,manifest);
		const receipt=await initializeMobileGit({...store,root:temp},initial);
		await protect();
		await publish(ctx,temp,input.parent,input.name,async()=>{
			if((await verified()).head!==receipt.head)throw new Error(tr('发布后的提交已变化','The published commit changed'));
		});
		await register();
		return {identity,location,...receipt};
	}finally{await ctx.disk.rmdir(temp,true);}
}
