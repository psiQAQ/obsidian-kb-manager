import git from 'isomorphic-git';
import {tr} from '../i18n.ts';
import {segments} from '../fs/segments.ts';
import {identityFile,readManifest,withManifestIgnore,writeIdentity} from '../kb/identity-core.ts';
import type {Identity} from '../kb/identity-core.ts';
import {builtinTemplate,kepanoSource,kepanoTemplate,kepanoBinding,declaration,excludedNames,renderBase} from '../kb/template-core.ts';
import type {Template,Variables} from '../kb/template-core.ts';
import {buffer,bytes,checkSpelling,children,decode,ensureFolder,hash,key,mobileRepo,relative,settingsPaths} from './disk.ts';
import {applyMobileRegistryIgnore,libraryPath,nested,previewMobileRegistryIgnore,readMobileRegistry,updateMobileRegistry} from './registration.ts';
import type {Catalog} from './registration.ts';

export {discoverMobile,verifyLibrary} from './registration.ts';
export type {Catalog,Library} from './registration.ts';
export interface Templates {wiki:Record<string,string>;kepano:Record<string,string>}
export interface Creation {parent:string;name:string;displayName:string;description:string;source:string}

export function newIdentity(displayName:string,description='',template={id:'unknown',version:'unknown'},entry?:string):Identity{
	return {schemaVersion:1,id:crypto.randomUUID(),displayName,description,archived:false,template,entry,managed:[]};
}

export async function destination(ctx:Catalog,parent:string,name:string){
	settingsPaths(ctx.parents,ctx.templates,ctx.configDir);
	if(!ctx.parents.includes(parent) || segments(name).length!==1 || await nested(ctx,parent))throw new Error(tr('请选择有效的目标目录','Choose a valid destination'));
	const path=libraryPath(ctx,parent+'/'+name);
	await checkSpelling(ctx.disk,path);
	if(await ctx.disk.stat(path))throw new Error(tr('目标已存在','Destination already exists')+': '+path);
	return path;
}
async function directoryTemplate(ctx:Catalog,root:string,vars:Variables):Promise<Template>{
	if(!ctx.templates.includes(root))throw new Error(tr('请选择已登记的模板','Select a registered template'));
	await checkSpelling(ctx.disk,root);
	const specPath=root+'/kb-template.json';
	const spec=(await ctx.disk.stat(specPath))?declaration(await ctx.disk.read(specPath)):{};
	const files:Template['files']=[],folders:string[]=[],excluded:string[]=[],sourceFiles:string[]=[];
	const values:Record<string,string>={kb_root:vars.destination,kb_name:vars.displayName,description:vars.description};
	async function scan(dir:string){
		const list=await children(ctx.disk,dir);
		for(const path of [...list.files,...list.folders].sort()){
			const name=path.slice(dir.length+1),file=path.slice(root.length+1);
			if(key(name)==='kb-manager.json')throw new Error(tr('模板含知识库身份文件','Template contains a library identity')+': '+file);
			if(key(name)===key(ctx.configDir) || excludedNames.has(key(name)) || file==='kb-template.json' ||
				(name.startsWith('.') && !['.gitignore','.gitkeep'].includes(name) && !spec.hidden?.includes(file))){excluded.push(file);continue;}
			relative(file,ctx.configDir);
			if(list.folders.includes(path)){folders.push(file);await scan(path);continue;}
			let data:Uint8Array=new Uint8Array(await ctx.disk.readBinary(path));
			if(key(name)===identityFile && (file!==identityFile || readManifest(decode(data)).identity))
				throw new Error(tr('模板含知识库身份文件','Template contains a library identity')+': '+file);
			sourceFiles.push(file+':'+await hash(data));
			const fields=spec.text?.[file];
			if(fields)data=bytes(decode(data).replace(/\{\{(kb_name|description|kb_root)\}\}/gu,(s,field:string)=>fields.includes(field)?values[field]!:s));
			if(file==='knowledge.base' && spec.managed?.length)data=bytes(renderBase(decode(data),vars.destination));
			files.push({name:file,bytes:data});
		}
	}
	await scan(root);
	for(const f of [...Object.keys(spec.text??{}),...(spec.entry?[spec.entry]:[]),...(spec.managed?['knowledge.base']:[])])
		if(!files.some(item=>item.name===f))throw new Error(tr('模板缺少文件','Missing template file')+': '+f);
	return {id:spec.id??'folder',version:spec.version??await hash(JSON.stringify([spec,folders,sourceFiles])),files,folders,excluded,entry:spec.entry,overview:!!spec.managed?.length};
}
export async function createPreview(ctx:Catalog,input:Creation,assets:Templates){
	const location=await destination(ctx,input.parent,input.name);
	if(!input.displayName.trim())throw new Error(tr('请填写显示名','Enter a display name'));
	const vars={...input,destination:location};
	const template=input.source===kepanoSource?kepanoTemplate(assets.kepano,location):input.source?
		await directoryTemplate(ctx,input.source,vars):builtinTemplate(assets.wiki,vars);
	const registryIgnore=await previewMobileRegistryIgnore(ctx);
	const signature=await hash(JSON.stringify([input,template.id,template.version,template.folders,template.excluded,template.entry,registryIgnore,
		await Promise.all(template.files.map(async f=>[f.name,await hash(f.bytes)]))]));
	return {location,input:{...input},template,signature,registryIgnore};
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
export async function publish(ctx:Catalog,src:string,parent:string,name:string){
	const dest=await destination(ctx,parent,name);
	await ctx.disk.mkdir(dest);
	async function copy(dir:string){
		const data=await children(ctx.disk,dir);
		for(const sub of data.folders){
			const target=dest+sub.slice(src.length);
			if(await ctx.disk.stat(target))throw new Error(tr('目录冲突','Directory collision')+': '+target);
			await ctx.disk.mkdir(target);await copy(sub);
		}
		for(const file of data.files)if(file!==src+'/'+identityFile)await ctx.disk.copy(file,dest+file.slice(src.length));
	}
	await copy(src);
	if(await ctx.disk.stat(src+'/'+identityFile))await ctx.disk.copy(src+'/'+identityFile,dest+'/'+identityFile);
}
export async function instantiate(ctx:Catalog,confirmed:Awaited<ReturnType<typeof createPreview>>,assets:Templates){
	const {input}=confirmed, fresh=await createPreview(ctx,input,assets);
	if(fresh.signature!==confirmed.signature)throw new Error(tr('模板已变化，请重新预览','Template changed. Review it again.'));
	await readMobileRegistry(ctx);
	const temp=await scratch(ctx,input.parent), template=fresh.template;
	try{
		const identity=newIdentity(input.displayName,input.description,{id:template.id,version:template.version},template.entry);
		const asset=(name:string)=>template.files.find(file=>file.name===name);
		for(const sub of template.folders)await ensureFolder(ctx.disk,temp+'/'+relative(sub,ctx.configDir));
		for(const file of template.files){
			if([identityFile,'.gitignore'].includes(file.name))continue;
			const loc=temp+'/'+relative(file.name,ctx.configDir);
			await ensureFolder(ctx.disk,loc.slice(0,loc.lastIndexOf('/')));await ctx.disk.writeBinary(loc,buffer(file.bytes));
			if(input.source===kepanoSource && kepanoBinding(assets.kepano,file.name))
				identity.managed.push({path:file.name,root:fresh.location,fingerprint:await hash(file.bytes),role:'kepano-bindings'});
			else if((!input.source || template.overview) && file.name==='knowledge.base')
				identity.managed.push({path:file.name,root:fresh.location,fingerprint:await hash(file.bytes),role:input.source?'overview-bindings':undefined});
		}
		const manifest=asset(identityFile),ignore=asset('.gitignore');
		await ctx.disk.write(temp+'/'+identityFile,writeIdentity(manifest?decode(manifest.bytes):'',identity));
		await ctx.disk.write(temp+'/.gitignore',withManifestIgnore(ignore?decode(ignore.bytes):''));
		await git.init({...mobileRepo(ctx.disk,temp,ctx.configDir),defaultBranch:'main'});
		await applyMobileRegistryIgnore(ctx,fresh.registryIgnore);
		await publish(ctx,temp,input.parent,input.name);
		try{await updateMobileRegistry(ctx,{add:[fresh.location]});}
		catch(error){throw new Error(String(error)+tr('。目录已创建，可通过扫描登记：','. The folder was created and can be registered from a scan: ')+fresh.location);}
		return identity;
	}finally{await ctx.disk.rmdir(temp,true);}
}
