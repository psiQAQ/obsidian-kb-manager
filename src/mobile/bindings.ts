import {tr} from '../i18n.ts';
import {rebindSlots} from '../kb/instance-text.ts';
import {rebind} from '../kb/bindings.ts';
import {identityFile,parseIdentity,writeIdentity} from '../kb/identity-core.ts';
import type {Identity,ManagedFile} from '../kb/identity-core.ts';
import {rebindKepano} from '../kb/kepano.ts';
import {isBuiltinWiki,isKepano,kepanoBinding,kepanoBindingAssets} from '../kb/template-core.ts';
import {checkSpelling,decode,hash,relative,replaceText} from './disk.ts';
import {discoverMobile,libraryPath,verifyLibrary} from './registration.ts';
import type {Catalog,Library} from './registration.ts';

interface Edit {path:string;from:string;before:string;after:string}
export interface BindingPreview {
	location:string;id:string;before:string;after:string;edits:Edit[];manual:string[];
}

function rebindFile(item:ManagedFile,identity:Identity,source:string,location:string,skeleton:Record<string,string>){
	if(!item.root || item.root===location)return undefined;
	if(item.role==='template-root' && item.offsets)return {content:rebindSlots(source,item.offsets,item.root,location,item.path),manual:[]};
	if(item.role==='kepano-bindings' && isKepano(identity.template)){
		const assets=kepanoBindingAssets(skeleton,identity.template.version);
		return kepanoBinding(assets,item.path)?rebindKepano(item.path,source,item.root,location,assets):undefined;
	}
	if(item.path==='knowledge.base' && (item.role==='overview-bindings' || (!item.role && isBuiltinWiki(identity.template))))
		return rebind(source,item.root,location);
	return undefined;
}

export async function previewBindings(ctx:Catalog,location:string,root:string,raw:string,skeleton:Record<string,string>):Promise<BindingPreview>{
	libraryPath(ctx,location);
	const identity=parseIdentity(raw),edits:Edit[]=[],manual:string[]=[];
	for(const item of identity.managed){
		if(!item.root || item.root===location)continue;
		const file=root+'/'+relative(item.path,ctx.configDir);
		await checkSpelling(ctx.disk,file);
		if((await ctx.disk.stat(file))?.type!=='file'){
			manual.push(item.path+' · '+tr('文件缺失','File missing'));continue;
		}
		const data=new Uint8Array(await ctx.disk.readBinary(file));
		if(identity.archived || await hash(data)!==item.fingerprint){
			manual.push(item.path+' · '+tr('保留现有内容，需人工复核','Keep existing content for review'));continue;
		}
		const before=decode(data),result=rebindFile(item,identity,before,location,skeleton);
		if(!result || result.manual.length){manual.push(item.path+' · '+tr('绑定需人工复核','Binding needs review'));continue;}
		edits.push({path:item.path,from:item.root,before,after:result.content});
		item.root=location;item.fingerprint=await hash(result.content);
	}
	return {location,id:identity.id,before:raw,after:edits.length?writeIdentity(raw,identity):raw,edits,manual};
}

export function bindingLines(plan:BindingPreview){
	return [...plan.edits.map(edit=>edit.path+' · '+edit.from+' → '+plan.location),...plan.manual];
}

async function applyFiles(ctx:Catalog,root:string,plan:BindingPreview){
	for(const edit of plan.edits){
		const path=root+'/'+relative(edit.path,ctx.configDir);
		await checkSpelling(ctx.disk,path);
		const current=await ctx.disk.read(path);
		if(current!==edit.before && current!==edit.after)throw new Error(tr('文件已变化，请复核','File changed. Review the file.')+' · '+path);
	}
	for(const edit of plan.edits)await replaceText(ctx.disk,root+'/'+edit.path,edit.before,edit.after,true);
}

export async function applyCloneBindings(ctx:Catalog,root:string,plan:BindingPreview){
	await applyFiles(ctx,root,plan);
	return plan.after;
}

export async function applyLibraryBindings(ctx:Catalog,lib:Library,plan:BindingPreview,skeleton:Record<string,string>,record:(plan?:BindingPreview)=>void){
	await verifyLibrary(ctx,lib,true);
	const fresh=await previewBindings(ctx,lib.location,lib.location,await ctx.disk.read(lib.location+'/'+identityFile),skeleton);
	if(JSON.stringify(fresh)!==JSON.stringify(plan))throw new Error(tr('绑定已变化，请重新预览','Bindings changed. Review them again.'));
	if(!plan.edits.length)return;
	record(plan);
	await resumeLibraryBindings(ctx,plan,skeleton);
	record();
}

// Verify a persisted recovery record against the current registration and the original managed declarations.
export async function resumeLibraryBindings(ctx:Catalog,plan:BindingPreview,skeleton:Record<string,string>){
	const lib=(await discoverMobile(ctx)).find(entry=>entry.location===plan.location);
	const identity=parseIdentity(plan.before);
	if(!lib || !lib.identity || lib.duplicate || lib.identity.archived || lib.identity.id!==plan.id || identity.id!==plan.id ||
		(lib.manifest!==plan.before && lib.manifest!==plan.after))throw new Error(tr('知识库清单已变化，请人工复核','Library manifest changed. Review the library.'));
	for(const {path,from,before,after} of plan.edits){
		const item=identity.managed.find(candidate=>candidate.path===path);
		const result=item?rebindFile(item,identity,before,plan.location,skeleton):undefined;
		if(!item || item.root!==from || !result || result.manual.length || result.content!==after || await hash(before)!==item.fingerprint)
			throw new Error(tr('恢复记录与受管文件不匹配','The recovery data does not match the managed files'));
		item.root=plan.location;item.fingerprint=await hash(after);
	}
	if(writeIdentity(plan.before,identity)!==plan.after)throw new Error(tr('恢复记录与清单不匹配','The recovery data does not match the manifest'));
	await applyFiles(ctx,plan.location,plan);
	await replaceText(ctx.disk,plan.location+'/'+identityFile,plan.before,plan.after,true);
}
