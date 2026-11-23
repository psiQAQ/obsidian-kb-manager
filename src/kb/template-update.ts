import { constants } from 'node:fs';
import { copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { tr } from '../i18n.ts';
import { identityFile, readManifest, recheck, retireTemplateFiles, writeIdentity, writeTemplateFileRecord } from './catalog.ts';
import type { Config, Identity, Library } from './catalog.ts';
import { checkInstructions, composeCheckReadme, installedCheckInstructions, readmePath } from './check-readme.ts';
import { instanceText } from './instance-text.ts';
import {classifyLibraryBinding} from './maintenance.ts';
import {classifyPathBinding,retirePathBindings} from './path-binding-ownership.ts';
import { readManifestFile, replaceLibraryManifest } from './manifest-disk.ts';
import { declaration } from './template-declaration.ts';
import { managedText, managedTextLimit } from './template-file-record.ts';
import { templateCompatibility } from './template-requirements.ts';
import type { TemplateHost } from './template-requirements.ts';
import {renderBase} from './template-core.ts';

function stale(name:string){
	return new Error(tr('模板、清单或目标文件已变化，请重新预览。','The template, manifest or destination file changed. Preview again.')+' · '+name);
}

async function snapshot(disk:VaultDisk,root:string,file:string){
	const relative=root+'/'+file;
	const path=await disk.path(relative);
	const directory=await disk.path(root);
	const parts=file.split('/');
	for(let depth=1;depth<parts.length;depth++){
		const parent=join(directory,...parts.slice(0,depth));
		for(const marker of [identityFile,'.git','kb-manager.json']){
			if(await statIfPresent(join(parent,marker)))
				throw new Error(tr('路径位于下级知识库或 Git 仓库中','The path is inside a nested library or repository')+' · '+relative);
		}
	}
	const stat=await statIfPresent(path);
	if(!stat)return {path};
	if(!stat.isFile() || stat.nlink!==1 || stat.size>managedTextLimit)
		throw new Error(tr('需要独立的常规文件（最多 1 MiB）。','Expected a regular file with a single link (up to 1 MiB).')+' · '+relative);
	const handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try{
		const same=(other:typeof stat|undefined)=>other?.isFile() && other.ino===stat.ino && other.dev===stat.dev &&
			other.size===stat.size && other.mtimeMs===stat.mtimeMs && other.ctimeMs===stat.ctimeMs && other.nlink===1;
		if(!same(await handle.stat()))throw stale(relative);
		const bytes=Buffer.alloc(stat.size+1);
		let size=0;
		while(size<bytes.length){
			const {bytesRead}=await handle.read(bytes,size,bytes.length-size,size);
			if(!bytesRead)break;
			size+=bytesRead;
		}
		if(size!==stat.size || !same(await handle.stat()) || await disk.path(relative)!==path || !same(await statIfPresent(path)))
			throw stale(relative);
		const content=bytes.subarray(0,size);
		return {path,text:managedText(relative,content),signature:digest(content),mode:stat.mode};
	} finally {await handle.close();}
}

async function renderManagedReadme(disk:VaultDisk,root:string,authorText:string,installed:string|undefined){
	const instructions=installedCheckInstructions(installed);
	if(instructions)return composeCheckReadme(authorText,instructions);
	// A previous template update may already have removed the guide. Recover it
	// from the library's own declaration, which the template update does not replace.
	const checks=await snapshot(disk,root,'kb-template.json').then(file=>
		file.text===undefined?undefined:declaration(file.text).checks??[]
	).catch(()=>undefined);
	return composeCheckReadme(authorText,checkInstructions(checks));
}

type Change='current'|'add'|'replace'|'conflict'|'missing'|'retained'|'unavailable';
interface FileUpdate {
	path:string; change:Change; before?:string; after?:string; installed?:string; target?:string;
	offsets?:number[]; retireBinding?:boolean; reason?:string;
}

function older(target:string,installed:string){
	if(![target,installed].every(value=>/^\d+(?:\.\d+){0,2}$/u.test(value)))return false;
	const before=installed.split('.').map(BigInt),after=target.split('.').map(BigInt);
	for(let index=0;index<3;index++){
		const a=after[index]??0n,b=before[index]??0n;
		if(a!==b)return a<b;
	}
	return false;
}

export async function previewTemplateUpdate(disk:VaultDisk,config:Config,expected:Library,source:string,host:TemplateHost){
	const library=await recheck(disk,config,expected);
	const manifest=await readManifestFile(await disk.path(library.location+'/'+identityFile));
	const {identity,templateFiles,checkKit}=readManifest(manifest.raw);
	if(library.signature!==manifest.signature || !identity || identity.archived || !templateFiles)
		throw new Error(tr('只有已记录受管模板文件的可写知识库可以应用此更新。','Template updates require a writable library with recorded managed files.'));
	if(!config.templates.includes(source))
		throw new Error(tr('请选择已登记的目录模板。','Select a registered folder template.'));
	const template=await snapshot(disk,source,'kb-template.json');
	if(template.text===undefined)throw new Error(tr('模板没有 kb-template.json。','The template has no kb-template.json.'));
	const spec=declaration(template.text);
	if(spec.id!==identity.template.id || !spec.version)
		throw new Error(tr('模板 ID 与此知识库不匹配，或未声明版本。','The template ID does not match this library, or the version is missing.'));
	const compatibility=templateCompatibility(spec,host);
	const names=spec.managedFiles ?? [];
	const files:FileUpdate[]=[];
	const vars={displayName:identity.displayName,description:identity.description,destination:library.location};
	for(const path of names){
		const original=await snapshot(disk,source,path);
		if(original.text===undefined)throw new Error(tr('缺少声明的文件：','Missing declared file: ')+path);
		const sourceText=path==='knowledge.base' && spec.managed?.length?renderBase(original.text,vars.destination):original.text;
		const rendered=instanceText(path,sourceText,spec.text?.[path] ?? [],vars);
		let after=rendered.content,target=digest(after);
		managedText(path,new TextEncoder().encode(after));
		const offsets=rendered.offsets.length?rendered.offsets:undefined;
		const binding=identity.managed.find(file=>file.path===path);
		const recorded=templateFiles.digests[path];
		try {
			const file=await snapshot(disk,library.location,path);
			if(path===readmePath && checkKit){
				after=await renderManagedReadme(disk,library.location,after,file.text);
				managedText(path,new TextEncoder().encode(after));
				target=digest(after);
			}
			const ownership=binding && file.text!==undefined && await classifyLibraryBinding(disk,library,binding,file.text);
			const scans=ownership && !ownership.opaque;
			const base={path,before:file.text,after,installed:file.signature,target,offsets,retireBinding:scans && !offsets ? true : undefined};
			if(binding && !scans && (binding.role!=='template-root' || !offsets)){
				files.push({...base,change:'conflict',reason:tr('路径绑定方式已变化。','The path binding has changed.')});
			} else if(file.signature===undefined){
				files.push({...base,change:recorded?'missing':'add'});
			} else if(!recorded){
				files.push({...base,change:'conflict',reason:tr('已有文件未登记为此模板的受管文件。','The existing file is outside this template’s managed records.')});
			} else if(file.signature===target){
				files.push({...base,change:'current'});
			} else {
				// A path rebind can keep user edits and still refresh its own fingerprint.
				// Only the recorded template version authorizes replacing the whole file.
				files.push({...base,change:file.signature===recorded?'replace':'conflict'});
			}
		} catch(error) {files.push({path,change:'unavailable',after,target,offsets,reason:String(error)});}
	}
	for(const path of Object.keys(templateFiles.digests))if(!names.includes(path))files.push({path,change:'retained'});
	const pending=files.some(file=>file.change==='conflict' || file.change==='missing' || file.change==='unavailable');
	const changes=files.some(file=>file.change==='add' || file.change==='replace' || file.change==='retained');
	const version=spec.version;
	const blockers=[...compatibility.blockers];
	if(older(version,templateFiles.version))blockers.push(tr('所选版本早于当前记录的版本。','The selected release is older than the recorded release.'));
	if(changes && version===templateFiles.version)blockers.push(tr('请使用新版本的模板。','Select a new template release.'));
	const canApply=!blockers.length && (changes || (!pending && version!==templateFiles.version));
	return {library,source,manifestSignature:manifest.signature,sourceSignature:template.signature,installedVersion:templateFiles.version,targetVersion:version,
		files,canApply,pending,blockers,optional:compatibility.optional};
}

export type TemplateUpdatePlan=Awaited<ReturnType<typeof previewTemplateUpdate>>;

function recordBinding(identity:Identity,file:FileUpdate,location:string){
	if(!file.offsets || !file.target)return;
	const known=identity.managed.find(binding=>binding.path===file.path);
	const next={role:'template-root' as const,root:location,offsets:file.offsets,fingerprint:file.target};
	if(known)Object.assign(known,next);
	else identity.managed.push({path:file.path,...next});
}

async function publish(disk:VaultDisk,root:string,file:FileUpdate,inspectEditor:(path:string,expected:string|undefined)=>void){
	const relative=root+'/'+file.path;
	const target=await disk.path(relative);
	if(file.change==='add'){
		const parent=relative.slice(0,relative.lastIndexOf('/'));
		await mkdir(await disk.path(parent),{recursive:true});
	}
	const initial=await snapshot(disk,root,file.path);
	if(initial.path!==target)throw stale(relative);
	if(initial.signature===file.target)return;
	if(initial.signature!==file.installed || file.after===undefined)throw stale(relative);
	const temporary=join(dirname(target),'.kb-template-'+randomUUID()+'.tmp');
	const handle=await open(temporary,'wx',initial.mode===undefined?0o666:initial.mode & 0o777);
	try{
		try {await handle.writeFile(file.after,'utf8');await handle.sync();}
		finally {await handle.close();}
		const current=await snapshot(disk,root,file.path);
		if(current.path!==target || current.signature!==file.installed)throw stale(relative);
		inspectEditor(relative,current.text);
		if(file.change==='add')await copyFile(temporary,target,constants.COPYFILE_EXCL);
		else await rename(temporary,target);
	} finally {await rm(temporary,{force:true});}
}

export async function applyTemplateUpdate(disk:VaultDisk,config:Config,approved:TemplateUpdatePlan,host:TemplateHost,
	inspectEditor:(path:string,expected:string|undefined)=>void=()=>{}){
	if(!approved.canApply)throw stale(approved.library.location);
	const {location}=approved.library;
	const fresh=await previewTemplateUpdate(disk,config,approved.library,approved.source,host);
	const sameFiles=fresh.files.length===approved.files.length && fresh.files.every((file,index)=>{
		const seen=approved.files[index];
		if(!seen || file.path!==seen.path || file.target!==seen.target || JSON.stringify(file.offsets)!==JSON.stringify(seen.offsets))return false;
		// A previous interrupted apply may already have written an approved byte sequence.
		if(file.installed===seen.target && seen.target!==undefined && (seen.change==='add' || seen.change==='replace')){
			if(file.retireBinding===seen.retireBinding)return true;
			const binding=fresh.library.identity?.managed.find(item=>item.path===file.path);
			const proof=seen.retireBinding && binding && seen.before!==undefined && digest(seen.before)===binding.fingerprint &&
				classifyPathBinding(binding,seen.before,fresh.library.identity?.template);
			return !!proof && !proof.opaque;
		}
		return file.change===seen.change && file.installed===seen.installed && file.retireBinding===seen.retireBinding;
	});
	if(fresh.blockers.length || fresh.manifestSignature!==approved.manifestSignature || fresh.sourceSignature!==approved.sourceSignature || !sameFiles)
		throw stale(location);
	const manifest=await readManifestFile(await disk.path(location+'/'+identityFile));
	if(manifest.signature!==approved.manifestSignature)throw stale(location);
	const accepted=approved.files.filter(file=>file.change==='add' || file.change==='replace' || file.change==='current');
	const retired=new Set(approved.files.filter(file=>file.change==='retained').map(file=>file.path));
	const retiredBindings=new Set(accepted.filter(file=>file.retireBinding).map(file=>file.path));
	const retainedManifest=retirePathBindings(retireTemplateFiles(manifest.raw,retired),retiredBindings);
	const {identity,templateFiles}=readManifest(retainedManifest);
	if(!identity || !templateFiles)throw stale(location);
	const filesToWrite=fresh.files.filter(file=>file.change==='add' || file.change==='replace');
	for(const file of filesToWrite)inspectEditor(location+'/'+file.path,file.before);
	for(const file of accepted){
		if(file.target)templateFiles.digests[file.path]=file.target;
		recordBinding(identity,file,location);
	}
	if(!approved.pending)templateFiles.version=approved.targetVersion;
	const after=writeTemplateFileRecord(writeIdentity(retainedManifest,identity),templateFiles);
	for(const file of filesToWrite)await publish(disk,location,file,inspectEditor);
	for(const file of accepted)if((await snapshot(disk,location,file.path)).signature!==file.target)throw stale(file.path);
	await replaceLibraryManifest(disk,location,manifest.signature,after);
}
