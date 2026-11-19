import * as fs from 'node:fs/promises';
import {dirname,join} from 'node:path';
import git from 'isomorphic-git';
import {repository} from './repository.ts';
import {previewVersion} from './versions.ts';
import {tr} from '../i18n.ts';
import {requireIdentity} from './identity.ts';
import type {GitIdentity} from './identity.ts';

export interface SquashPlan {head:string; branch:string; base:string; identity:GitIdentity; commits:{oid:string;message:string}[]}

export async function squashPreview(dir:string,base:string):Promise<SquashPlan>{
	const {branch,head,changes,identity}=await previewVersion(dir);
	if(changes.length)throw new Error(tr('压缩前请处理工作区与暂存区','Commit or store working and staged changes before squashing'));
	if(!/^[0-9a-f]{40}$/u.test(base))throw new Error(tr('上游提交无效','Invalid upstream commit'));
	const commits:SquashPlan['commits']=[];
	let oid=head;
	while(oid!==base){
		const {commit}=await git.readCommit({...repository(dir),oid});
		if(commit.parent.length!==1)throw new Error(tr('仅可压缩上游之后的线性提交','Only a linear series following the upstream can be squashed'));
		commits.push({oid,message:commit.message.trim()});
		oid=commit.parent[0]!;
	}
	return {head,branch,base,commits,identity};
}

export async function squash(dir:string,plan:SquashPlan,message:string){
	if(plan.commits.length<2 || !message.trim())throw new Error(tr('压缩需要至少两次提交和说明','Squashing requires two commits and a message'));
	const fresh=await squashPreview(dir,plan.base);
	const author=requireIdentity(fresh.identity);
	if(JSON.stringify(plan)!==JSON.stringify(fresh))throw new Error(tr('提交范围已变化','The commit range changed'));
	const repo=repository(dir),ref='refs/heads/'+plan.branch,branchFile=join(repo.gitdir,ref);
	await fs.mkdir(dirname(branchFile),{recursive:true});
	const headLock=await fs.open(join(repo.gitdir,'HEAD.lock'),'wx');
	try{
		const lock=await fs.open(branchFile+'.lock','wx');
		let published=false;
		try {
			if(await git.currentBranch(repo)!==plan.branch || await git.resolveRef({...repo,ref})!==plan.head)throw new Error(tr('分支已变化','Branch changed'));
			const {commit}=await git.readCommit({...repo,oid:plan.head});
			const who={...author,timestamp:Math.floor(Date.now()/1000),timezoneOffset:new Date().getTimezoneOffset()};
			const oid=await git.writeCommit({...repo,commit:{tree:commit.tree,parent:[plan.base],author:who,committer:who,message:message.trim()+'\n'}});
			const archive='refs/kb-manager/before-squash/'+plan.head;
			try {await git.writeRef({...repo,ref:archive,value:plan.head});}
			catch(error){if(await git.resolveRef({...repo,ref:archive})!==plan.head)throw error;}
			await lock.writeFile(oid+'\n');await lock.sync();await lock.close();
			await fs.rename(branchFile+'.lock',branchFile);
			published=true;return oid;
		}finally{
			await lock.close();
			if(!published)await fs.unlink(branchFile+'.lock');
		}
	}finally{await headLock.close();await fs.unlink(join(repo.gitdir,'HEAD.lock'));}
}
