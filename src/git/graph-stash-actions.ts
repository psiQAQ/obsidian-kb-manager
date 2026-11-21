import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { tr } from '../i18n.ts';
import { statIfPresent } from '../fs/vault.ts';
import { checkedIdentityArgs } from './identity.ts';
import { checkedNative, gitResult } from './network-native.ts';
import { changePlan, refName, resolveRef, tree } from './network.ts';
import { readCommit } from './repository.ts';
import { previewVersion } from './versions.ts';

const changed=()=>new Error(tr('工作区或贮藏条目已变化，请重新预览','The working tree or stash changed. Preview again.'));
const protectedPaths=new Set(['kb.toml','kb-manager.json','.gitattributes']);
const isUntracked=(file:{head:number;work:number;stage:number})=>!file.head && !file.stage && Boolean(file.work);

async function safeWorkPaths(dir:string,files:readonly string[]){
	for(const file of files){
		const stat=await lstat(path.join(dir,file)).catch((error:NodeJS.ErrnoException)=>{
			if(error.code!=='ENOENT')throw error;
		});
		if(stat && (!stat.isFile() || stat.nlink!==1))throw new Error(tr('不支持的贮藏文件：','Unsupported stash file: ')+file);
	}
}

export async function graphStashSavePlan(dir:string,includeUntracked:boolean){
	const {head,branch,signature,identity,changes}=await previewVersion(dir);
	if(!head)throw new Error(tr('请先创建首个提交','Create the first commit before stashing.'));
	const files=changes.filter(file=>includeUntracked || !isUntracked(file)).map(file=>file.file);
	if(!files.length)throw new Error(tr('没有可贮藏的改动','There are no changes to stash.'));
	if(files.some(file=>protectedPaths.has(file.toLowerCase())))throw new Error(tr('贮藏将包含库清单或 Git 属性，请先处理这些文件','Resolve the library manifest or Git attributes changes before stashing.'));
	await safeWorkPaths(dir,files);
	return {head,branch,signature,identity,files,includeUntracked};
}

export async function saveGraphStash(dir:string,plan:Awaited<ReturnType<typeof graphStashSavePlan>>,message:string){
	const fresh=await graphStashSavePlan(dir,plan.includeUntracked);
	if(JSON.stringify(fresh)!==JSON.stringify(plan))throw changed();
	const run=await checkedNative(dir),identity=await checkedIdentityArgs(dir,plan.identity);
	await run([...identity,'stash','push',...(plan.includeUntracked?['--include-untracked']:[]),
		...(message.trim()?['--message',message.trim()]:[]),'--pathspec-from-file=-','--pathspec-file-nul'],undefined,plan.files.join('\0')+'\0');
}

type Stash={ref:string;oid:string};
type StashAction='apply'|'pop'|'drop'|'branch';

async function verifyStash(dir:string,stash:Stash){
	if(!/^stash@\{(?:0|[1-9][0-9]*)\}$/u.test(stash.ref) || !/^[a-f0-9]{40}$/u.test(stash.oid) || await resolveRef(dir,stash.ref)!==stash.oid)
		throw changed();
}

export async function graphStashPlan(dir:string,stash:Stash,action:StashAction){
	await checkedNative(dir);
	await verifyStash(dir,stash);
	if(action==='drop')return {stash,action,files:[] as string[]};
	const {commit}=await readCommit(dir,stash.oid);
	const [base,index,untracked]=commit.parent;
	if(!base || !index || commit.parent.length>3)throw new Error(tr('不支持的贮藏对象','Unsupported stash object.'));
	const {head,branch,signature,changes}=await previewVersion(dir);
	if(!head || changes.length)throw new Error(tr('应用贮藏前请保存当前工作区改动','Save working tree changes before applying the stash.'));
	const destination=action==='branch'?base:head;
	const move=action==='branch'?await changePlan(dir,base):undefined;
	const [original,saved,staged,extras,target]=await Promise.all([
		tree(dir,base),tree(dir,stash.oid),tree(dir,index),untracked?tree(dir,untracked):new Map<string,string>(),tree(dir,destination),
	]);
	const files=[...new Set([...original.keys(),...saved.keys(),...staged.keys(),...extras.keys()])].filter(file=>
		saved.get(file)!==original.get(file)||staged.get(file)!==original.get(file)||extras.has(file));
	for(const file of files){
		if(protectedPaths.has(file.toLowerCase()))throw new Error(tr('贮藏会改动库清单或 Git 属性','The stash changes a library manifest or Git attributes.'));
		if(target.get(file)!==original.get(file) || extras.has(file) && target.has(file) ||
			!target.has(file) && await statIfPresent(path.join(dir,file)))throw new Error(tr('目标已包含与贮藏重叠的改动：','The target contains changes that overlap with the stash: ')+file);
	}
	await safeWorkPaths(dir,files);
	return {stash,action,head,branch,signature,base,move,files:[...new Set([...(move?.changes??[]),...files])]};
}

export async function applyGraphStash(dir:string,plan:Awaited<ReturnType<typeof graphStashPlan>>,name?:string){
	if(JSON.stringify(await graphStashPlan(dir,plan.stash,plan.action))!==JSON.stringify(plan))throw changed();
	const run=await checkedNative(dir);
	if(plan.action==='drop'){
		await verifyStash(dir,plan.stash);
		await run(['stash','drop','--',plan.stash.ref]);
		return;
	}
	const branch=plan.action==='branch'?refName(name??''):undefined;
	try{
		// A full object ID pins the selected stash and preserves its reflog entry.
		await run(branch?['stash','branch',branch,plan.stash.oid]:['stash','apply','--index',plan.stash.oid]);
	}catch(error){
		const result=await gitResult(dir,['diff','--no-ext-diff','--no-textconv','--name-only','--diff-filter=U','-z','--']).catch(()=>undefined);
		const files=result?.stdout.toString().split('\0').filter(Boolean)??[];
		if(files.length)throw new Error(tr('贮藏仍保留。请先解决以下文件的冲突：','The stash was kept. Resolve conflicts in these files: ')+files.join(', '));
		if(branch && (await gitResult(dir,['symbolic-ref','--short','HEAD']).catch(()=>undefined))?.stdout.toString().trim()===branch)
			throw new Error(tr('已切换到新分支。贮藏仍保留，请检查工作区再重试。','Switched to the new branch. The stash was kept. Review the working tree before retrying.'));
		throw error;
	}
	if(plan.action==='pop'){
		try{
			await verifyStash(dir,plan.stash);
			await run(['stash','drop','--',plan.stash.ref]);
		}catch{
			throw new Error(tr('贮藏已应用到工作区，但未删除贮藏引用。请刷新再检查。','The stash has been applied to the working tree. Refresh and inspect the stash reference before removing it.'));
		}
	}
}
