import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitResult } from '../git/network-native.ts';
import { VaultDisk, digest, key, statIfPresent, validateFolders } from '../fs/vault.ts';
import { renameNewDirectory } from '../fs/publish.ts';
import { existingDirectory, segments } from '../fs/paths.ts';
import { guardGit } from '../git/guard.ts';
import { repository } from '../git/repository.ts';
import { ancestorWarnings } from './create.ts';
import { discover, identityFile, parseIdentity, recheck, writeIdentity } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { examine } from './maintenance.ts';
import type { Repair, VisibleFiles } from './maintenance.ts';
import { isKepano, kepanoBinding, kepanoBindingAssets } from './template.ts';
import {rebindSlots} from './instance-text.ts';
import { validateKepanoRoot } from './kepano.ts';
import { readManifestFile, replaceLibraryManifest } from './manifest-disk.ts';
import { registerVaultLibrary } from '../registry/discovery.ts';

export interface MoveRecord {
	token:string; id:string; source:string; destination:string; git:string; manifest:string;
	changes:Repair[]; warnings:string[]; phase:'prepared'|'moved'|'complete';
}

async function gitStamp(dir:string) {
	if(!await statIfPresent(path.join(dir,'.git')))return 'missing';
	const branch=await guardGit(dir),repo=repository(dir);
	const head=(await gitResult(dir,['rev-parse','--verify','--quiet','HEAD'],{allowedExitCodes:[0,1]})).stdout.toString().trim();
	const index=path.join(repo.gitdir,'index');
	return JSON.stringify([branch,head,await statIfPresent(index)?digest(await fs.readFile(index)):'']);
}

export async function planMove(disk:VaultDisk,config:Config,lib:Library,parent:string,name:string,skeleton:Record<string,string>):Promise<MoveRecord>{
	validateFolders(disk,config.parents,config.templates);
	await recheck(disk,config,lib);
	if(!lib.identity || lib.identity.archived || !config.parents.includes(parent) || segments(name).length!==1)throw new Error(tr('无效的移动目标或库状态','Invalid move destination or library state'));
	const destination=parent+'/'+name, source=lib.location;
	if(isKepano(lib.identity.template))validateKepanoRoot(destination);
	if(source===destination)throw new Error(tr('源和目标相同','Source and destination are identical'));
	const parentPath=await disk.path(parent);
	const dir=await disk.path(source);
	const parentStat=await statIfPresent(parentPath);
	if(!parentStat?.isDirectory() || parentStat.dev!==(await fs.stat(dir)).dev)throw new Error(tr('目标父目录须已存在并位于同一文件系统','The destination parent must exist on the same filesystem'));
	const collision=(await fs.readdir(parentPath)).find(n=>key(n)===key(name));
	if(collision && parent+'/'+collision!==source)throw new Error(tr('目标已存在：','Destination already exists: ')+collision);
	const warnings=await ancestorWarnings(disk,destination);
	const report=await examine(disk,lib,skeleton,destination);
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
	}
	if(changes.length)changes.push({file:identityFile,before:signature,after:writeIdentity(previous,next),fields:[tr('记录新绑定位置','Record the new binding locations')]});
	return {token:randomUUID(),id:lib.identity.id,source,destination,git:await gitStamp(dir),manifest:signature,
		changes,warnings:[...warnings,...report.manual],phase:'prepared'};
}

export async function executeMove(disk:VaultDisk,config:Config,record:MoveRecord,files:VisibleFiles,save:(value:MoveRecord)=>Promise<void>,kepanoSkeleton:Record<string,string>={}){
	const parent=(file:string)=>path.posix.dirname(file);
	if(!config.parents.includes(parent(record.destination)))throw new Error(tr('目标父目录登记已变化','The registered destination parent changed'));
	disk.validate(record.source);disk.validate(record.destination);
	const sourceParent=parent(record.source)==='.'?await fs.realpath(disk.root):await disk.path(parent(record.source));
	const targetParent=await disk.path(parent(record.destination));
	const source=path.join(sourceParent,path.posix.basename(record.source));
	const destination=path.join(targetParent,path.posix.basename(record.destination));
	const intermediate=path.join(sourceParent,'.kb-rename-'+record.token);
	if(!/^[a-f0-9-]{36}$/u.test(record.token))throw new Error(tr('无效的恢复记录','Invalid move recovery record'));
	const exact=async(file:string)=>(await fs.readdir(path.dirname(file))).includes(path.basename(file));
	const locations=[];
	for(const file of [source,intermediate,destination])if(await exact(file))locations.push(file);
	if(locations.length!==1)throw new Error(tr('源或目标位置有冲突，请保留现场','Conflicting source or destination. Preserve both locations for review.'));
	const current=locations[0]!;
	if(!(await fs.lstat(current)).isDirectory())throw new Error(tr('无效的库目录','Invalid library directory'));
	const manifestPath=path.join(current,identityFile);
	const {raw:manifest,signature}=await readManifestFile(manifestPath);
	const identity=parseIdentity(manifest);
	if(identity.id!==record.id || (await gitStamp(current))!==record.git)throw new Error(tr('ID、HEAD 或索引变化，请人工复核','Library ID, HEAD or the index changed. Review the library before continuing.'));
	const manifestEdit=record.changes.find(c=>c.file===identityFile);
	if(signature!==record.manifest && !(current===destination && manifestEdit && digest(manifestEdit.after)===signature))throw new Error(tr('清单已变化','The library manifest changed'));
	const duplicate=(await discover(disk,config)).some(lib=>lib.identity?.id===record.id && ![record.source,record.destination].includes(lib.location));
	if(duplicate)throw new Error(tr('ID 重复','Duplicate library ID'));
	const bindingAssets=kepanoBindingAssets(kepanoSkeleton,identity.template.version);
	for(const item of record.changes){
		const binding=identity.managed.find(m=>m.path===item.file);
		const allowed=binding?.role==='template-root' || (isKepano(identity.template)?binding?.role==='kepano-bindings' && kepanoBinding(bindingAssets,item.file):item.file==='knowledge.base' && !!binding);
		if(item.file!==identityFile && !allowed)throw new Error(tr('恢复记录包含未受管文件','The recovery record includes an unmanaged file'));
		if(item.file!==identityFile && binding?.fingerprint!==item.before && !(current===destination && binding?.fingerprint===digest(item.after)))
			throw new Error(tr('受管文件的指纹已变化','A managed file fingerprint changed'));
		if(item.file.includes('/'))await existingDirectory(current,path.posix.dirname(item.file));
		const f=path.join(current,item.file);
		const stat=await fs.lstat(f);
		if(!stat.isFile() || stat.nlink!==1)throw new Error(tr('受管路径发生变化：','Managed path changed: ')+item.file);
		const bytes=await fs.readFile(f),hash=digest(bytes);
		if(hash===item.before && binding?.role==='template-root' && binding.root && binding.offsets &&
			rebindSlots(bytes.toString('utf8'),binding.offsets,binding.root,record.destination)!==item.after)
			throw new Error(tr('恢复数据与路径绑定不一致','Recovery record differs from the path binding'));
		if(hash!==item.before && !(current===destination && hash===digest(item.after)))throw new Error(tr('文件已被编辑：','File was edited: ')+item.file);
	}
	if(current!==destination){
		let at=current;
		if(at===source && key(record.source)===key(record.destination)){
			await renameNewDirectory(source,intermediate);at=intermediate;
		}
		if(await statIfPresent(destination))throw new Error(tr('目标已被占用','The destination is occupied'));
		await renameNewDirectory(at,destination);
	}
	record={...record,phase:'moved'};await save(record);
	for(const item of record.changes){
		const relative=record.destination+'/'+item.file;
		const absolute=await disk.path(relative);
		const content=await fs.readFile(absolute);
		if(digest(content)===digest(item.after))continue;
		if(item.before===null || digest(content)!==item.before)throw new Error(tr('已移动，文件变化，请复核：','The directory moved and this file changed. Review: ')+relative);
		if(item.file===identityFile)await replaceLibraryManifest(disk,record.destination,item.before,item.after);
		else await files.replace(relative,item.before,item.after);
	}
	await registerVaultLibrary(disk,config,record.destination,record.source);
	await save({...record,phase:'complete'});
}
