import { tr } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import git from 'isomorphic-git';
import { VaultDisk, digest, key, statIfPresent, validateFolders } from '../fs/vault.ts';
import { renameNewDirectory } from '../fs/publish.ts';
import { segments } from '../fs/paths.ts';
import { guardGit } from '../git/guard.ts';
import { repository } from '../git/repository.ts';
import { ancestorWarnings } from './create.ts';
import { discover, identityFile, parseIdentity, recheck } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { examine } from './maintenance.ts';
import type { Repair, VisibleFiles } from './maintenance.ts';

export interface MoveRecord {
	token:string; id:string; source:string; destination:string; git:string; manifest:string;
	changes:Repair[]; warnings:string[]; phase:'prepared'|'moved'|'complete';
}

async function gitStamp(dir:string) {
	if(!await statIfPresent(path.join(dir,'.git')))return 'missing';
	const branch=await guardGit(dir),repo=repository(dir);
	let head='';
	try{head=await git.resolveRef({...repo,ref:'HEAD'});}catch(e){if(!(e instanceof git.Errors.NotFoundError))throw e;}
	const index=path.join(repo.gitdir,'index');
	return JSON.stringify([branch,head,await statIfPresent(index)?digest(await fs.readFile(index)):'']);
}

export async function planMove(disk:VaultDisk,config:Config,lib:Library,parent:string,name:string,skeleton:Record<string,string>):Promise<MoveRecord>{
	validateFolders(disk,config.parents,config.templates);
	await recheck(disk,config,lib);
	if(!lib.identity || lib.identity.archived || !config.parents.includes(parent) || segments(name).length!==1)throw new Error(tr('无效的移动目标或库状态','Invalid move destination or library state'));
	const destination=parent+'/'+name, source=lib.location;
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
	const previous=await fs.readFile(manifestFile,'utf8');
	const next=parseIdentity(previous);
	const base=next.managed.find(m=>m.path==='knowledge.base');
	const changes=report.repairs.filter(r=>r.before!==null);
	if(base && changes[0]){base.root=destination;base.fingerprint=digest(changes[0].after);}
	const afterManifest=JSON.stringify(next,null,2)+'\n';
	if(base && changes[0])changes.push({file:identityFile,before:digest(previous),after:afterManifest,fields:[tr('记录新 Base 绑定位置','Record the new Base binding location')]});
	return {token:randomUUID(),id:lib.identity.id,source,destination,git:await gitStamp(dir),manifest:digest(previous),
		changes,warnings:[...warnings,...report.manual],phase:'prepared'};
}

export async function executeMove(disk:VaultDisk,config:Config,record:MoveRecord,files:VisibleFiles,save:(value:MoveRecord)=>Promise<void>){
	const parent=(file:string)=>path.posix.dirname(file);
	for(const file of [record.source,record.destination]){
		if(!config.parents.includes(parent(file)))throw new Error(tr('父目录登记已变化','Registered parent folders changed'));
		disk.validate(file);
	}
	const sourceParent=await disk.path(parent(record.source)), targetParent=await disk.path(parent(record.destination));
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
	if(!(await fs.lstat(manifestPath)).isFile())throw new Error(tr('无效的身份文件','Invalid library identity file'));
	const manifest=await fs.readFile(manifestPath,'utf8');
	if(parseIdentity(manifest).id!==record.id || (await gitStamp(current))!==record.git)throw new Error(tr('ID、HEAD 或索引变化，请人工复核','Library ID, HEAD or the index changed. Review the library before continuing.'));
	const manifestEdit=record.changes.find(c=>c.file===identityFile);
	if(digest(manifest)!==record.manifest && !(current===destination && manifestEdit && digest(manifestEdit.after)===digest(manifest)))throw new Error(tr('清单已变化','The library manifest changed'));
	const duplicate=(await discover(disk,config)).some(lib=>lib.identity?.id===record.id && ![record.source,record.destination].includes(lib.location));
	if(duplicate)throw new Error(tr('ID 重复','Duplicate library ID'));
	for(const item of record.changes){
		if(!['knowledge.base',identityFile].includes(item.file))throw new Error(tr('恢复记录包含未受管文件','The recovery record includes an unmanaged file'));
		const f=path.join(current,item.file);
		if(!(await fs.lstat(f)).isFile())throw new Error(tr('受管路径发生变化：','Managed path changed: ')+item.file);
		const hash=digest(await fs.readFile(f));
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
		await files.replace(relative,item.before,item.after);
	}
	await save({...record,phase:'complete'});
}
