import {tr} from '../i18n.ts';
import {gitResult,sshRoute} from './network-native.ts';
import {digest} from '../fs/vault.ts';

const sshAddress=/^(?:([A-Za-z0-9_][\w.-]*)@)?([A-Za-z0-9][\w.-]*):([^:]+)$/u;
const bad=()=>new Error(tr('请输入不带密码、令牌、查询参数的 HTTPS 或 SSH 仓库地址','Use an HTTPS or SSH repository address without passwords, tokens, or query parameters.'));
export function endpoint(raw:string){
	if(!raw || raw.trim()!==raw || /[\s\\?#]/u.test(raw) || Array.from(raw).some(c=>c.charCodeAt(0)<32) || /^[A-Za-z]:/u.test(raw))throw bad();
	const scp=raw.match(sshAddress);
	if(scp && !raw.includes('://')){
		if(!/^[\w./%~+-]+$/u.test(scp[3]!))throw bad();
		return raw;
	}
	let url:URL;
	try{url=new URL(raw);}catch{throw bad();}
	if(!url.hostname || url.password || url.search || url.hash || url.pathname==='/')throw bad();
	if(url.protocol==='ssh:'){
		if(url.username && !/^[A-Za-z0-9_][\w.-]*$/u.test(url.username))throw bad();
		if(!/^[\w./%~+-]+$/u.test(url.pathname))throw bad();
	}else if(url.username || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw bad();
	return url.toString();
}
export function isSsh(url:string){return !/^https?:\/\//u.test(url);}
export async function address(dir:string|undefined,raw:string,remote?:string,push=false){
	const url=endpoint(raw);
	const args=remote?['remote','get-url',...(push?['--push']:[]),'--all',remote]:['ls-remote','--get-url','--',url];
	if(push && !remote){
		const entries=await gitResult(dir,['config','--null','--get-regexp','^url\\..*\\.pushinsteadof$'],{allowedExitCodes:[0,1]});
		for(const row of entries.stdout.toString().split('\0').filter(Boolean)){
			if(url.startsWith(row.slice(row.indexOf('\n')+1)))
				throw new Error(tr('Git 推送地址重写改变了预览目标','A Git push URL rewrite affects the proposed destination.'));
		}
	}
	const values=(await gitResult(dir,args)).stdout.toString().trimEnd().split(/\r?\n/u);
	// Git applies pushInsteadOf / insteadOf before invoking a transport. A
	// reviewed URL must never become another destination between UI and network.
	if(values.length!==1 || endpoint(values[0]!)!==url)throw new Error(tr('Git 地址重写或多个目标改变了预览地址，请在原仓核对。','Git rewrites or multiple destinations change the reviewed address. Review the repository configuration.'));
	let display=url,route=url;
	if(isSsh(url)){
		const scp=url.includes('://')?null:url.match(sshAddress);
		const parsed=scp ? new URL('ssh://'+(scp[1]?scp[1]+'@':'')+scp[2]+'/'+scp[3]) : new URL(url);
		const ssh=await sshRoute(parsed,dir);
		display=url+' → '+ssh.display;
		route+='\n'+ssh.signature;
	}
	return {url,display,signature:digest(route)};
}
