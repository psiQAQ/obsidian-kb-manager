import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindingHistory } from '../diagnostics/binding-history.ts';
import { gitResult } from '../git/network-native.ts';
import { VaultDisk, digest, key, statIfPresent } from '../fs/vault.ts';
import { renameNewDirectory } from '../fs/publish.ts';
import { existingDirectory } from '../fs/paths.ts';
import { guardGit } from '../git/guard.ts';
import { repository } from '../git/repository.ts';
import { ancestorWarnings } from './create.ts';
import { discover, identityFile, parseIdentity, readManifest, recheck, writeIdentity } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { classifyLibraryBinding, examine } from './maintenance.ts';
import type { Repair, VisibleFiles } from './maintenance.ts';
import { isKepano, kepanoBinding, kepanoBindingAssets } from './template.ts';
import {rebindSlots} from './instance-text.ts';
import { validateKepanoRoot } from './kepano.ts';
import { readManifestFile, replaceLibraryManifest } from './manifest-disk.ts';
import { assertNoAncestorLibrary, registerVaultLibrary } from '../registry/discovery.ts';
import { assertUnreservedLibraryPath, libraryDestination, validateLibraryPath, vaultParent, vaultPath } from '../registry/paths.ts';
import { retirePathBindings } from './path-binding-ownership.ts';

import { applyExclusionPlan, assertExclusionPlan, assertMoveExclusionScope, planMovedExclusions } from './template-exclusions.ts';
import type { ExclusionPlan, ExclusionStore } from './template-exclusions.ts';
import { prepareReferenceWrites } from './move-references.ts';
import type { ReferenceEdit } from './move-references.ts';

export interface MoveRecord {
	token:string; id:string; source:string; destination:string; git:string; manifest:string;
	changes:Repair[]; warnings:string[]; exclusions?:ExclusionPlan; phase:'prepared'|'moved'|'complete';
	references?:ReferenceEdit[];
}

export interface MoveFiles extends VisibleFiles {
	renameFolder?(source:string,destination:string):Promise<void>;
}

async function gitStamp(dir:string) {
	if(!await statIfPresent(path.join(dir,'.git')))return 'missing';
	const branch=await guardGit(dir),repo=repository(dir);
	const head=(await gitResult(dir,['rev-parse','--verify','--quiet','HEAD'],{allowedExitCodes:[0,1]})).stdout.toString().trim();
	const index=path.join(repo.gitdir,'index');
	return JSON.stringify([branch,head,await statIfPresent(index)?digest(await fs.readFile(index)):'']);
}

export async function planMove(disk:VaultDisk,config:Config,lib:Library,parent:string,name:string,skeleton:Record<string,string>,store?:ExclusionStore,
	originals?:Map<string,string>):Promise<MoveRecord>{
	await recheck(disk,config,lib);
	if(!lib.identity || lib.identity.archived)throw new Error(tr('无效的库状态','Invalid library state'));
	const destination=validateLibraryPath(libraryDestination(parent,name),disk.configDir,config.templates), source=lib.location;
	if(isKepano(lib.identity.template))validateKepanoRoot(destination);
	if(source===destination)throw new Error(tr('源和目标相同','Source and destination are identical'));
	assertUnreservedLibraryPath((await disk.registry.read()).paths,destination,[source]);
	const parentPath=await disk.folder(parent);
	const dir=await disk.path(source);
	const parentStat=await statIfPresent(parentPath);
	if(!parentStat?.isDirectory() || parentStat.dev!==(await fs.stat(dir)).dev)throw new Error(tr('目标父目录须已存在并位于同一文件系统','The destination parent must exist on the same filesystem'));
	const collision=(await fs.readdir(parentPath)).find(n=>key(n)===key(name) && vaultPath(parent,n)!==source);
	if(collision)throw new Error(tr('目标已存在：','Destination already exists: ')+collision);
	if(key(destination)!==key(source))await disk.path(destination);
	const warnings=await ancestorWarnings(disk,destination);
	const report=await examine(disk,lib,skeleton,destination,originals);
	const manifestFile=path.join(dir,identityFile);
	const {raw:previous,signature}=await readManifestFile(manifestFile);
	if(signature!==lib.signature)throw new Error(tr('清单已变化','The library manifest changed'));
	const next=parseIdentity(previous);
	const changes=report.repairs.filter(r=>r.before!==null);
	for(const change of changes){
		const binding=next.managed.find(m=>m.path===change.file);
		if(!binding)throw new Error(tr('未登记的受管文件：','Unregistered managed file: ')+change.file);
		binding.root=destination;
		binding.fingerprint=digest(change.after);
		if(change.bindingOffsets)binding.offsets=change.bindingOffsets;
	}
	const retired=new Set(report.retired);
	if(changes.length || retired.size){
		originals?.set(identityFile,previous);
		const fields=[];
		if(changes.length)fields.push(tr('记录新绑定位置','Record the new binding locations'));
		if(retired.size)fields.push(tr('移除已由普通引用扫描处理的旧绑定','Retire legacy bindings covered by the reference scan')+' · '+[...retired].join(', '));
		changes.push({file:identityFile,before:signature,after:retirePathBindings(writeIdentity(previous,next),retired),fields});
	}
	const exclusions=store && await planMovedExclusions(store,next.id,source,destination,next.excludedFolders ?? []);
	return {token:randomUUID(),exclusions,id:lib.identity.id,source,destination,git:await gitStamp(dir),manifest:signature,
		changes,warnings:[...warnings,...report.manual],phase:'prepared'};
}

function manifestAfterReferences(record:MoveRecord, managedManifest:Repair|undefined) {
	if(!managedManifest)return undefined;
	const changes=new Map(record.changes.filter(change=>change.file!==identityFile).map(change=>[record.source+'/'+change.file,change]));
	const overlaps=(record.references ?? []).flatMap(edit=>{
		const managed=edit && changes.get(edit.file);
		return managed ? [{edit,managed}] : [];
	});
	if(!overlaps.length)return managedManifest.after;
	const identity=parseIdentity(managedManifest.after);
	for(const {edit,managed} of overlaps){
		const binding=identity.managed.find(item=>item.path===managed.file);
		if(!managed.patches?.length || !binding || binding.fingerprint!==digest(managed.after) || edit.before!==managed.before ||
			!/^[a-f0-9]{64}$/u.test(edit.result) || (managed.bindingOffsets===undefined)!==(edit.bindingOffsets===undefined) ||
			(edit.bindingOffsets!==undefined && (!Array.isArray(edit.bindingOffsets) || edit.bindingOffsets.length!==managed.bindingOffsets?.length)))
			throw new Error(tr('恢复数据与路径绑定不一致','Recovery record differs from the path binding'));
		binding.fingerprint=edit.result;
		if(edit.bindingOffsets)binding.offsets=edit.bindingOffsets;
	}
	return writeIdentity(managedManifest.after,identity);
}

export async function executeMove(disk:VaultDisk,config:Config,record:MoveRecord,files:MoveFiles,save:(value:MoveRecord)=>Promise<void>,kepanoSkeleton:Record<string,string>={},store?:ExclusionStore){
	await disk.registry.assertWritable();
	disk.validate(record.source);
	validateLibraryPath(record.destination,disk.configDir,config.templates);
	const sourceParent=await disk.folder(vaultParent(record.source));
	const targetParent=await disk.folder(vaultParent(record.destination));
	await assertNoAncestorLibrary(disk,record.destination);
	const source=path.join(sourceParent,path.posix.basename(record.source));
	const destination=path.join(targetParent,path.posix.basename(record.destination));
	const intermediate=path.join(sourceParent,'.kb-rename-'+record.token);
	if(!/^[a-f0-9-]{36}$/u.test(record.token))throw new Error(tr('无效的恢复记录','Invalid move recovery record'));
	const exact=async(file:string)=>(await fs.readdir(path.dirname(file))).includes(path.basename(file));
	const locations=[];
	for(const file of [source,intermediate,destination])if(await exact(file))locations.push(file);
	if(locations.length!==1)throw new Error(tr('源或目标位置有冲突，请保留现场','Conflicting source or destination. Preserve both locations for review.'));
	const current=locations[0]!;
	const currentStat=await fs.lstat(current);
	if(!currentStat.isDirectory() || currentStat.dev!==(await fs.stat(targetParent)).dev)
		throw new Error(tr('无效的库目录或文件系统','Invalid library folder or filesystem'));
	const manifestPath=path.join(current,identityFile);
	const {raw:manifest,signature}=await readManifestFile(manifestPath);
	const {identity}=readManifest(manifest);
	if(!identity || identity.archived || identity.id!==record.id || (await gitStamp(current))!==record.git)
		throw new Error(tr('知识库已归档，或 ID、HEAD、索引变化，请人工复核','The library was archived, or its ID, HEAD or index changed. Review the library before continuing.'));
	const assertUnreserved=async()=>{
		const allowed=current===destination && record.phase==='moved'?[record.source,record.destination]:[record.source];
		assertUnreservedLibraryPath((await disk.registry.read()).paths,record.destination,allowed);
	};
	await assertUnreserved();
	if(record.exclusions){
		if(!store)throw new Error(tr('缺少 Vault 排除规则存储','The vault exclusion settings are unavailable'));
		assertMoveExclusionScope(record.exclusions,identity.id,record.source,record.destination,identity.excludedFolders ?? []);
		await assertExclusionPlan(store,record.exclusions,current===destination);
	}
	const manifestEdit=record.changes.find(c=>c.file===identityFile);
	if((manifestEdit && manifestEdit.before!==record.manifest) ||
		(record.references!==undefined && !Array.isArray(record.references)))
		throw new Error(tr('无效的恢复记录','Invalid move recovery record'));
	const manifestAfter=manifestAfterReferences(record,manifestEdit);
	if(signature!==record.manifest && !(current===destination && manifestAfter!==undefined && digest(manifestAfter)===signature))throw new Error(tr('清单已变化','The library manifest changed'));
	const libraries=await discover(disk,config);
	const duplicate=libraries.some(lib=>lib.identity?.id===record.id && ![record.source,record.destination].includes(lib.location));
	if(duplicate)throw new Error(tr('ID 重复','Duplicate library ID'));
	const bindingAssets=kepanoBindingAssets(kepanoSkeleton,identity.template.version);
	const selectedReferences=new Map((record.references ?? []).map(edit=>[edit.file,edit]));
	for(const item of record.changes){
		if(item.file===identityFile)continue;
		const binding=identity.managed.find(m=>m.path===item.file);
		const allowed=binding?.role==='template-root' || (isKepano(identity.template)?binding?.role==='kepano-bindings' && kepanoBinding(bindingAssets,item.file):item.file==='knowledge.base' && !!binding);
		if(!allowed)throw new Error(tr('恢复记录包含未受管文件','The recovery record includes an unmanaged file'));
		const reference=selectedReferences.get(record.source+'/'+item.file);
		const result=reference?.result ?? digest(item.after);
		if(item.bindingBefore!==undefined && (item.bindingBefore===item.before || !item.patches?.length || binding?.role!=='template-root'))
			throw new Error(tr('恢复数据与路径绑定不一致','Recovery record differs from the path binding'));
		if(binding?.fingerprint!==(item.bindingBefore ?? item.before) && !(current===destination && binding?.fingerprint===result))
			throw new Error(tr('受管文件的指纹已变化','A managed file fingerprint changed'));
		if(item.file.includes('/'))await existingDirectory(current,path.posix.dirname(item.file));
		const f=path.join(current,item.file);
		const stat=await fs.lstat(f);
		if(!stat.isFile() || stat.nlink!==1)throw new Error(tr('受管路径发生变化：','Managed path changed: ')+item.file);
		const bytes=await fs.readFile(f),hash=digest(bytes);
		if(hash===item.before && binding?.role==='template-root' && binding.root && binding.offsets){
			const text=bytes.toString('utf8');
			const classified=item.patches && await classifyLibraryBinding(disk,{location:record.source,identity},binding,text,kepanoSkeleton,
				undefined,item.bindingBefore ? bindingHistory(current,disk.root) : undefined);
			const effective=classified?.opaque ?? binding;
			if((item.bindingBefore && !classified?.verifiedAppend) || !effective.root || !effective.offsets ||
				rebindSlots(text,effective.offsets,effective.root,record.destination,binding.path)!==item.after)
				throw new Error(tr('恢复数据与路径绑定不一致','Recovery record differs from the path binding'));
		}
		if(hash!==item.before && !(current===destination && hash===result))throw new Error(tr('文件已被编辑：','File was edited: ')+item.file);
	}
	const references=await prepareReferenceWrites(disk,config,record,libraries,current,
		{location:record.source,identity},current===destination);
	await disk.registry.assertWritable();
	if(current!==destination){
		await assertUnreserved();
		const collision=(await fs.readdir(targetParent)).find(name=>
			key(name)===key(path.basename(destination)) && path.join(targetParent,name)!==source);
		if(collision)throw new Error(tr('目标已被占用','The destination is occupied')+' · '+collision);
		if(files.renameFolder && current===source){
			await files.renameFolder(record.source,record.destination);
		}else{
			let at=current;
			if(at===source && key(record.source)===key(record.destination)){
				await renameNewDirectory(source,intermediate);at=intermediate;
			}
			if(await statIfPresent(destination))throw new Error(tr('目标已被占用','The destination is occupied'));
			await renameNewDirectory(at,destination);
		}
		if(!await exact(destination) || await exact(source) || await exact(intermediate))
			throw new Error(tr('无法核验移动后的目录位置','Could not verify the folder location after moving'));
	}
	record={...record,phase:'moved'};await save(record);
	for(const item of record.changes){
		if(item.file===identityFile || selectedReferences.has(record.source+'/'+item.file))continue;
		const relative=record.destination+'/'+item.file;
		const absolute=await disk.path(relative);
		const content=await fs.readFile(absolute);
		if(digest(content)===digest(item.after))continue;
		if(item.before===null || digest(content)!==item.before)throw new Error(tr('已移动，文件变化，请复核：','The directory moved and this file changed. Review: ')+relative);
		await files.replace(relative,item.before,item.after);
	}
	for(const edit of references)await files.replace(edit.file,edit.before,edit.after);
	if(manifestAfter!==undefined && digest(manifestAfter)!==signature)
		await replaceLibraryManifest(disk,record.destination,record.manifest,manifestAfter);
	if(record.exclusions && store)await applyExclusionPlan(store,record.exclusions);
	await registerVaultLibrary(disk,config,record.destination,record.source);
	await save({...record,phase:'complete'});
}
