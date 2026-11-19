import { gitResult } from './network-native.ts';
import { readCommit } from './repository.ts';
import { previewVersion } from './versions.ts';
import { tr } from '../i18n.ts';
import { checkedIdentityArgs } from './identity.ts';
import type { GitIdentity } from './identity.ts';

export interface SquashPlan {head:string;branch:string;base:string;identity:GitIdentity;commits:{oid:string;message:string}[]}

export async function squashPreview(dir:string,base:string):Promise<SquashPlan>{
	const {branch,head,changes,identity}=await previewVersion(dir);
	if(changes.length)throw new Error(tr('压缩前请处理工作区与暂存区','Commit or store working and staged changes before squashing'));
	if(!/^[0-9a-f]{40}$/u.test(base))throw new Error(tr('上游提交无效','Invalid upstream commit'));
	const commits:SquashPlan['commits']=[];
	let oid=head;
	while(oid!==base){
		const {commit}=await readCommit(dir,oid);
		if(commit.parent.length!==1)throw new Error(tr('仅可压缩上游之后的线性提交','Only linear history after the upstream can be squashed'));
		commits.push({oid,message:commit.message.trim()});oid=commit.parent[0]!;
	}
	return {head,branch,base,commits,identity};
}

export async function squash(dir:string,plan:SquashPlan,message:string){
	if(plan.commits.length<2 || !message.trim())throw new Error(tr('压缩需要至少两次提交及说明','Squashing requires two commits and a message'));
	const fresh=await squashPreview(dir,plan.base);
	if(JSON.stringify(plan)!==JSON.stringify(fresh))throw new Error(tr('提交范围或身份已变化','Commit range or identity changed'));
	const identityArgs=await checkedIdentityArgs(dir,fresh.identity);
	const {commit}=await readCommit(dir,plan.head);
	const oid=(await gitResult(dir,[...identityArgs,'commit-tree','--no-gpg-sign',commit.tree,'-p',plan.base,'-F','-'],{stdin:message.trim()+'\n'})).stdout.toString().trim();
	const archive='refs/kb-manager/before-squash/'+plan.head;
	const saved=(await gitResult(dir,['rev-parse','--verify','--quiet',archive],{allowedExitCodes:[0,1]})).stdout.toString().trim();
	if(saved && saved!==plan.head)throw new Error(tr('原提交保全引用发生冲突','The recovery ref points to a different commit'));
	const commands=[saved?'verify '+archive+' '+plan.head:'create '+archive+' '+plan.head,'update refs/heads/'+plan.branch+' '+oid+' '+plan.head];
	await gitResult(dir,['update-ref','--stdin'],{stdin:commands.join('\n')+'\n'});
	return oid;
}
