import { checkedIdentityArgs, readRepositoryIdentity } from './identity.ts';
import { assertPrivateManifestHistory } from './manifest-privacy.ts';
import { authOptions, localConfig, refName, resolveRef } from './network.ts';
import type { Credentials, RemoteTarget } from './network.ts';
import { address } from './network-http.ts';
import { checkedNative, gitResult } from './network-native.ts';
import { tr } from '../i18n.ts';

const emptyOid='0'.repeat(40);
const changed=()=>new Error(tr('引用或远端已变化，请重新预览','The reference or remote changed. Preview again.'));

export async function requireGraphCommit(dir:string,oid:string){
	if(!/^[a-f0-9]{40}$/u.test(oid) || await resolveRef(dir,oid)!==oid)throw changed();
}

export async function createGraphBranch(dir:string,name:string,oid:string){
	const run=await checkedNative(dir);
	await requireGraphCommit(dir,oid);
	await run(['update-ref','--no-deref','-m','branch: created from '+oid,'refs/heads/'+refName(name),oid,emptyOid]);
}

export async function renameGraphBranch(dir:string,ref:string,oid:string,name:string){
	const run=await checkedNative(dir),oldName=branchRefName(ref);
	if(await resolveRef(dir,ref)!==oid)throw changed();
	await run(['branch','--move','--',oldName,refName(name)]);
}

function branchRefName(ref:string){
	if(!ref.startsWith('refs/heads/'))throw new Error(tr('请选择一个本地分支','Select a local branch.'));
	return refName(ref.slice('refs/heads/'.length));
}

async function verifyTag(dir:string,tag:{ref:string;oid:string;tagOid?:string}){
	if(!tag.ref.startsWith('refs/tags/'))throw new Error(tr('请选择一个标签','Select a tag.'));
	await gitResult(dir,['check-ref-format',tag.ref]);
	const raw=(await gitResult(dir,['rev-parse','--verify','--end-of-options',tag.ref])).stdout.toString().trim();
	if(raw!==(tag.tagOid??tag.oid) || await resolveRef(dir,tag.ref)!==tag.oid)throw changed();
	return raw;
}

export async function graphTagDetails(dir:string,tag:{ref:string;oid:string;tagOid?:string}){
	const oid=await verifyTag(dir,tag);
	if(!tag.tagOid)return undefined;
	const result=(await gitResult(dir,['cat-file','tag',oid])).stdout.toString('utf8');
	const separator=result.indexOf('\n\n');
	if(separator<0)throw new Error(tr('Git 标签对象无效','Invalid Git tag object.'));
	return {tagger:result.slice(0,separator).split('\n').find(line=>line.startsWith('tagger '))?.slice(7),message:result.slice(separator+2).trimEnd()};
}

export async function createGraphTag(dir:string,name:string,oid:string,message:string,identity?:Awaited<ReturnType<typeof readRepositoryIdentity>>['identity']){
	const run=await checkedNative(dir),tagName=refName(name);
	await requireGraphCommit(dir,oid);
	if(message.trim()){
		if(!identity)throw new Error(tr('请先预览标签署名','Preview the tagger before creating a tag.'));
		const args=await checkedIdentityArgs(dir,identity);
		await run([...args,'tag','--no-sign','--annotate','--cleanup=verbatim','--file=-','--',tagName,oid],undefined,message);
	}else await run(['update-ref','--no-deref','-m','tag: created from '+oid,'refs/tags/'+tagName,oid,emptyOid]);
}

export async function deleteGraphTag(dir:string,tag:{ref:string;oid:string;tagOid?:string}){
	const run=await checkedNative(dir),raw=await verifyTag(dir,tag);
	await run(['update-ref','--no-deref','-d',tag.ref,raw]);
}

export async function graphRemoteTarget(dir:string,remote:string,branch:string):Promise<RemoteTarget>{
	await checkedNative(dir);
	refName(remote,true);refName(branch);
	const fields=await localConfig(dir);
	const urls=fields.filter(([key])=>key==='remote.'+remote+'.url').map(([,value])=>value);
	const pushUrls=fields.filter(([key])=>key==='remote.'+remote+'.pushurl').map(([,value])=>value);
	if(urls.length!==1 || pushUrls.length>1)throw new Error(tr('请选择只配置一个地址的远端','Choose a remote with a single address.'));
	const fetch=await address(dir,urls[0]!,remote),push=await address(dir,pushUrls[0]??urls[0]!,remote,true);
	return {remote,remoteBranch:branch,url:fetch.url,pushUrl:push.url,fetchDisplay:fetch.display,pushDisplay:push.display,
		signature:JSON.stringify([fetch.signature,push.signature])};
}

export async function fetchGraphBranch(dir:string,target:RemoteTarget,credentials?:Credentials){
	await verifyGraphRemote(dir,target);
	const ref='refs/heads/'+target.remoteBranch,tracking='refs/remotes/'+target.remote+'/'+target.remoteBranch;
	await gitResult(dir,['fetch','--refmap=','--no-tags','--no-recurse-submodules','--',target.remote,ref+':'+tracking],authOptions(target.url,credentials));
}

export async function verifyGraphRemote(dir:string,target:RemoteTarget){
	if(JSON.stringify(await graphRemoteTarget(dir,target.remote,target.remoteBranch))!==JSON.stringify(target))throw changed();
}

export async function trackGraphBranch(dir:string,ref:string,oid:string,remote:string,name:string){
	const run=await checkedNative(dir),prefix='refs/remotes/'+refName(remote,true)+'/';
	if(!ref.startsWith(prefix) || await resolveRef(dir,ref)!==oid)throw changed();
	const branch=refName(ref.slice(prefix.length));
	const fields=await localConfig(dir);
	const mappings=fields.filter(([key])=>key==='remote.'+remote+'.fetch').map(([,value])=>value.replace(/^\+/u,''));
	if(mappings.length!==1 || !['refs/heads/*:'+prefix+'*','refs/heads/'+branch+':'+ref].includes(mappings[0]!))
		throw new Error(tr('请先在本库远端设置中核对跟踪规则','Review the tracking rules in library remote settings first.'));
	await run(['branch','--track','--',refName(name),ref]);
}

export async function pushGraphTag(dir:string,tag:{ref:string;oid:string;tagOid?:string},target:RemoteTarget,credentials?:Credentials){
	if(!/^[a-f0-9]{40}$/u.test(tag.oid))throw changed();
	await assertPrivateManifestHistory(dir,tag.oid);
	await verifyGraphRemote(dir,target);
	const raw=await verifyTag(dir,tag);
	await gitResult(dir,['push','--no-verify','--no-follow-tags','--recurse-submodules=no','--porcelain','--',target.remote,raw+':'+tag.ref],authOptions(target.pushUrl,credentials));
}
