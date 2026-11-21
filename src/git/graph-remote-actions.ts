import { tr } from '../i18n.ts';
import { verifyGraphRemote } from './graph-ref-actions.ts';
import { authOptions, refName } from './network.ts';
import type { Credentials, RemoteTarget } from './network.ts';
import { address } from './network-http.ts';
import { gitResult } from './network-native.ts';

const stale=()=>new Error(tr('远端引用或本地跟踪引用已变化，请重新预览','The remote or tracking reference changed. Preview again.'));

async function remoteRefs(dir:string,url:string,args:string[],credentials?:Credentials){
	const rows=(await gitResult(dir,['ls-remote','--refs',...args,'--',url],authOptions(url,credentials))).stdout.toString().trimEnd();
	return new Map(rows.split(/\r?\n/u).filter(Boolean).map(line=>{
		const match=/^([0-9a-f]{40})\t(refs\/(?:heads|tags)\/[^\s]+)$/u.exec(line);
		if(!match?.[1] || !match[2])throw new Error(tr('远端返回了无效引用','The remote advertised an invalid ref.'));
		return [match[2],match[1]];
	}));
}

interface RemoteDeletion { target:RemoteTarget; ref:string; oid:string }

export async function graphRemoteDeletion(dir:string,target:RemoteTarget,ref:string,oid:string,credentials?:Credentials):Promise<RemoteDeletion>{
	await verifyGraphRemote(dir,target);
	if((ref!=='refs/heads/'+target.remoteBranch && !ref.startsWith('refs/tags/')) || !/^[0-9a-f]{40}$/u.test(oid))throw stale();
	await gitResult(dir,['check-ref-format',ref]);
	// Observe the push endpoint. A remote can have separate fetch and push URLs.
	await address(dir,target.pushUrl);
	const kind=ref.startsWith('refs/heads/')?'--heads':'--tags';
	const advertised=await remoteRefs(dir,target.pushUrl,[kind],credentials);
	if(advertised.get(ref)!==oid)throw stale();
	return {target,ref,oid};
}

export async function deleteGraphRemoteReference(dir:string,plan:RemoteDeletion,credentials?:Credentials){
	const {target,ref,oid}=plan;
	await graphRemoteDeletion(dir,target,ref,oid,credentials);
	await gitResult(dir,['push','--no-verify','--no-follow-tags','--recurse-submodules=no','--porcelain',
		'--force-with-lease='+ref+':'+oid,'--',target.remote,':'+ref],authOptions(target.pushUrl,credentials));
}

interface PrunePlan {target:RemoteTarget;refs:{ref:string;oid:string}[]}

export async function graphPrunePlan(dir:string,target:RemoteTarget,credentials?:Credentials):Promise<PrunePlan>{
	await verifyGraphRemote(dir,target);
	await address(dir,target.url);
	const prefix='refs/remotes/'+refName(target.remote,true)+'/';
	const [server,local]=await Promise.all([
		remoteRefs(dir,target.url,['--heads'],credentials),
		gitResult(dir,['for-each-ref','--format=%(objectname)%09%(refname)%09%(symref)',prefix]),
	]);
	const refs=local.stdout.toString().split(/\r?\n/u).filter(Boolean).flatMap(line=>{
		const [oid,ref,symbolic]=line.split('\t');
		if(!oid || !/^[a-f0-9]{40}$/u.test(oid) || !ref?.startsWith(prefix) || /\s/u.test(ref))throw stale();
		if(symbolic || server.has('refs/heads/'+ref.slice(prefix.length)))return [];
		return [{ref,oid}];
	});
	// Only prune refs associated with the selected remote's standard head mapping.
	const mappings=(await gitResult(dir,['config','--local','--get-all','remote.'+target.remote+'.fetch'],{allowedExitCodes:[0,1]})).stdout.toString().trim().split(/\r?\n/u);
	if(mappings.length!==1 || mappings[0]?.replace(/^\+/u,'')!=='refs/heads/*:'+prefix+'*')
		throw new Error(tr('非标准远端映射请在外部核对后清理','Review and prune custom remote mappings in Git.'));
	return {target,refs};
}

export async function pruneGraphRemote(dir:string,plan:PrunePlan,credentials?:Credentials){
	if(!plan.refs.length || JSON.stringify(await graphPrunePlan(dir,plan.target,credentials))!==JSON.stringify(plan))throw stale();
	const commands=plan.refs.flatMap(({ref,oid})=>['option no-deref','delete '+ref+' '+oid]);
	await gitResult(dir,['update-ref','--stdin'],{stdin:['start',...commands,'prepare','commit',''].join('\n')});
}
