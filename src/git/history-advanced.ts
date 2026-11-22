import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {digest,statIfPresent} from '../fs/vault.ts';
import {tr} from '../i18n.ts';
import {guardGit} from './guard.ts';
import {activeOperation,checkGraphPaths,recoveryState,writableGraphPath} from './graph-recovery.ts';
import {checkedIdentityArgs,readRepositoryIdentity} from './identity.ts';
import {assertPrivateManifestHistory,assertPrivateManifestTree} from './manifest-privacy.ts';
import {ancestor,authOptions,refName,remoteState,resolveRef,tree} from './network.ts';
import type {Credentials} from './network.ts';
import {gitResult} from './network-native.ts';
import {address} from './network-http.ts';
import {fields,headOid,readCommit} from './repository.ts';
import {withIndexCopy} from './index-transaction.ts';

export type AdvancedAction = 'cherry-pick'|'revert'|'drop'|'soft'|'mixed'|'hard'|'clean'|'restore'|
	'detach'|'attach'|'force-push'|'continue'|'abort'|'resolve';
export interface AdvancedRequest {
	action:AdvancedAction; oid?:string; ref?:string; file?:string; mainline?:number;
}
const stale=()=>new Error(tr('仓库或操作目标已变化，请重新预览','Repository or target changed. Preview again.'));
const dirty=()=>new Error(tr('请先提交或储藏当前改动','Commit or stash your changes first'));
const list=async(dir:string,args:string[])=>fields((await gitResult(dir,args)).stdout);
const stagedTreeCheck=async(dir:string)=>assertPrivateManifestTree(dir,(await gitResult(dir,['write-tree'])).stdout.toString().trim());

export async function advancedPreview(dir:string,request:AdvancedRequest,credentials?:Credentials){
	const {action,oid,ref,file}=request;
	const op=await activeOperation(dir);
	const recovering=['continue','abort','resolve'].includes(action);
	if(recovering && !op)throw stale();
	const branch=await guardGit(dir,new Set(),false,'resolved',recovering?op:action==='attach'?'detached':undefined);
	const head=await headOid(dir);
	if(!head)throw new Error(tr('知识库尚无提交','The library has no commits'));
	if(oid && !/^[0-9a-f]{40}$/u.test(oid))throw new Error('Invalid commit');
	if(ref){
		if(!/^refs\/(heads|remotes|tags)\//u.test(ref) || !oid || await resolveRef(dir,ref)!==oid)throw stale();
	}
	const index=await fs.readFile(join(dir,'.git','index'));
	const config=await fs.readFile(join(dir,'.git','config'));
	const {tracked,staged,untracked,unstaged}=await withIndexCopy(dir,async indexFile=>{
		const read=async(args:string[])=>fields((await gitResult(dir,args,{indexFile})).stdout);
		const diff=['-c','diff.autoRefreshIndex=true','diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z'];
		return {
			tracked:await read([...diff,'HEAD','--']),
			staged:await read([...diff,'--cached','HEAD','--']),
			untracked:await read(['ls-files','--others','--exclude-standard','-z']),
			unstaged:await read([...diff,'--']),
		};
	});
	const changed=[...new Set([...tracked,...staged,...unstaged,...untracked])].sort();
	const bytes:string[]=[];
	for(const name of changed){
		const full=join(dir,name),stat=await statIfPresent(full);
		if(stat && !stat.isFile())throw new Error('Unexpected working path: '+name);
		const hash=createHash('sha256');
		if(stat)for await(const chunk of createReadStream(full))hash.update(chunk as Buffer);
		bytes.push(name,stat?hash.digest('hex'):'deleted');
	}
	const identity=(await readRepositoryIdentity(dir)).identity;
	const paths=new Set<string>(),refs:string[]=[],commits:string[]=[];
	let leaving:string[]=[],entering:string[]=[];
	let remoteOid='',route='',recoveryDigest='';
	if(['cherry-pick','revert','drop','detach','attach'].includes(action) && changed.length)throw dirty();
	if(action==='clean'){
		for(const name of untracked)if(writableGraphPath(name) && !/^(?:checks\/|kb-template\.json$)/iu.test(name))paths.add(name);
		if(!paths.size)throw new Error(tr('没有可清理的未跟踪文件','No eligible untracked files'));
	}else if(recovering && op){
		const state=await recoveryState(dir,op);
		recoveryDigest=state.metadata;commits.push(...state.commits);
		if(state.branchRef)refs.push(state.branchRef);
		if(action==='resolve'){
			if(!file || !state.conflicts.includes(file))throw stale();
			paths.add(file);
		}else{
			if(action==='continue' && state.conflicts.length)throw new Error(tr('请先编辑并标记已解决的冲突文件','Resolve and stage conflicted files first'));
			for(const name of [...state.paths,...tracked,...staged])paths.add(name);
			if(action==='continue' && staged.includes('kb.toml'))throw new Error('Protected library manifest');
		}
	}else if(action==='force-push'){
		const {target}=await remoteState(dir);
		if(!target || !oid)throw new Error(tr('请先配置本库上游分支','Configure the library upstream first'));
		await address(dir,target.pushUrl);
		const destination='refs/heads/'+target.remoteBranch;
		const adv=(await gitResult(dir,['ls-remote','--refs','--',target.pushUrl,destination],authOptions(target.pushUrl,credentials))).stdout.toString().trim();
		remoteOid=adv.split('\t')[0]??'';
		if(!/^[0-9a-f]{40}$/u.test(remoteOid) || adv.split('\t')[1]!==destination)throw new Error(tr('找不到远端目标分支','Remote destination branch not found'));
		refs.push(target.pushDisplay+' · '+destination);route=target.signature;
		if((await gitResult(dir,['cat-file','-e',remoteOid+'^{commit}'],{allowedExitCodes:[0,1,128]})).code!==0)
			throw new Error(tr('请先获取远端提交，再核对强推将移出的历史','Fetch the remote tip to review the history that would be displaced'));
		await assertPrivateManifestHistory(dir,oid);commits.push(remoteOid,oid);
	}else{
		if(!oid)throw new Error('Choose a commit');
		const {commit}=await readCommit(dir,oid);
		const before=await tree(dir,head),after=await tree(dir,oid);
		await assertPrivateManifestTree(dir,oid);
		const addDelta=(left:Map<string,string>,right:Map<string,string>)=>{
			for(const name of new Set([...left.keys(),...right.keys()]))if(left.get(name)!==right.get(name))paths.add(name);
		};
		commits.push(head,oid);
		if(action==='restore'){
			if(!file || !after.has(file))throw new Error(tr('此修订没有该文件','File is absent from this revision'));
			paths.add(file);
		}else if(action==='cherry-pick' || action==='revert'){
			const mainline=request.mainline??1;
			if(!Number.isInteger(mainline) || mainline<1 || mainline>Math.max(1,commit.parent.length))throw new Error('Invalid mainline parent');
			const parent=commit.parent[mainline-1];
			addDelta(parent?await tree(dir,parent):new Map<string,string>(),after);
		}else if(action==='drop'){
			if(commit.parent.length!==1 || !await ancestor(dir,oid,head))throw new Error(tr('请选择当前分支上的普通非根提交','Choose a non-root, single-parent commit on this branch'));
			if((await gitResult(dir,['rev-list','--merges',oid+'..'+head])).stdout.length)throw new Error(tr('该范围含合并提交，请单独审阅','The rewrite range contains merges'));
			const replay=(await gitResult(dir,['rev-list',oid+'..'+head])).stdout.toString().trim().split('\n').filter(Boolean);
			commits.push(...replay);
			const base=await tree(dir,commit.parent[0]!);
			addDelta(base,after);addDelta(base,before);
			for(const revision of replay)addDelta(base,await tree(dir,revision));
		}else{
			addDelta(before,after);
			if(action==='mixed' || action==='hard')for(const name of staged)paths.add(name);
			if(action==='hard')for(const name of [...tracked,...unstaged])paths.add(name);
			if(action==='attach'){
				if(!ref?.startsWith('refs/heads/') || branch!=='HEAD')throw stale();
				refName(ref.slice(11));
			}
		}
	}
	await checkGraphPaths(dir,paths);
	if(!['clean','soft','mixed','force-push','resolve'].includes(action)){
		// Git may overwrite an ignored path during checkout/reset. Never include those files implicitly.
		const ignored=await list(dir,['ls-files','--others','--ignored','--exclude-standard','-z']);
		const protectedFiles=new Set(ignored.map(p=>p.toLowerCase()));
		for(const name of paths){
			if(protectedFiles.has(name.toLowerCase()))throw new Error(tr('操作会覆盖忽略的文件','Operation would overwrite an ignored file')+' · '+name);
		}
	}
	if(!['clean','restore','force-push','resolve'].includes(action))refs.unshift(branch==='HEAD' || action==='detach' || action==='attach'?'HEAD':'refs/heads/'+branch);
	if(action==='detach' || action==='attach')refs.push(ref??oid!);
	if(oid && ['soft','mixed','hard','force-push'].includes(action)){
		const oldTip=action==='force-push'?remoteOid:head;
		const sides=(await gitResult(dir,['rev-list','--left-right',oldTip+'...'+oid])).stdout.toString().trim().split('\n');
		leaving=sides.filter(line=>line.startsWith('<')).map(line=>line.slice(1));
		entering=sides.filter(line=>line.startsWith('>')).map(line=>line.slice(1));
	}
	const files=[...paths].sort();
	const indexPaths=['soft','clean','force-push'].includes(action)?[]:files;
	const workPaths=['soft','mixed','resolve','force-push'].includes(action)?[]:files;
	return {request:{...request},op,branch,head,identity,refs,paths:files,indexPaths,workPaths,commits:[...new Set(commits)],leaving,entering,
		remoteOid,route,signature:digest(JSON.stringify([digest(index),digest(config),bytes,recoveryDigest]))};
}

export async function applyAdvanced(dir:string,plan:Awaited<ReturnType<typeof advancedPreview>>,credentials?:Credentials){
	const fresh=await advancedPreview(dir,plan.request,credentials);
	if(JSON.stringify(fresh)!==JSON.stringify(plan))throw stale();
	const {action,oid,ref,file,mainline}=plan.request;
	const args:string[]=[];
	if(['revert','cherry-pick','drop','continue'].includes(action))args.push(...await checkedIdentityArgs(dir,plan.identity));
	args.push('-c','core.editor=true','-c','sequence.editor=true','-c','rebase.updateRefs=false','-c','rebase.autoStash=false',
		'-c','rerere.enabled=false','-c','rebase.autoSquash=false');
	const run=(command:string[])=>gitResult(dir,[...args,...command]);
	switch(action){
		case 'clean': await run(['clean','-f','--',...plan.paths]);break;
		case 'soft':case 'mixed':case 'hard': await run(['reset','--'+action,'--no-recurse-submodules',oid!]);break;
		case 'restore':await run(['restore','--staged','--worktree','--source='+oid,'--',file!]);break;
		case 'detach':await run(['switch','--detach','--no-recurse-submodules',oid!]);break;
		case 'attach':await run(['switch','--no-recurse-submodules',refName(ref!.slice(11))]);break;
		case 'drop':{
			const {commit}=await readCommit(dir,oid!);
			await run(['rebase','--no-autostash','--onto',commit.parent[0]!,oid!]);break;
		}
		case 'cherry-pick':case 'revert':{
			const {commit}=await readCommit(dir,oid!);
			await run([action,'--no-edit',...(commit.parent.length>1?['-m',String(mainline??1)]:[]),oid!]);break;
		}
		case 'continue':case 'abort':
			if(action==='continue')await stagedTreeCheck(dir);
			await run([plan.op!,'--'+action]);break;
		case 'resolve':await run(['add','-A','--',file!]);break;
		case 'force-push':{
			const {target}=await remoteState(dir);
			if(!target || target.signature!==plan.route || plan.refs[0]!==target.pushDisplay+' · refs/heads/'+target.remoteBranch)throw stale();
			const dest='refs/heads/'+target.remoteBranch;
			await gitResult(dir,['push','--porcelain','--no-follow-tags','--no-recurse-submodules','--force-with-lease='+dest+':'+plan.remoteOid,'--',target.remote,oid+':'+dest],authOptions(target.pushUrl,credentials));
		}
	}
}
