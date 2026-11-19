import type {HttpClient} from 'isomorphic-git';
import {tr} from '../i18n.ts';

export function endpoint(raw:string){
	const url=new URL(raw);
	if(raw.trim()!==raw || /[\s\\?#]/u.test(raw) || url.protocol!=='https:' || url.username || url.password || url.pathname==='/' || url.search || url.hash)throw new Error(tr('请输入不含凭据的 HTTPS 地址','Enter an HTTPS URL without embedded credentials'));
	return url.href;
}

// requestUrl does not expose redirect controls. Authenticated Git traffic must
// fail closed instead of transparently forwarding a request to a new URL.
export function mobileHttp(raw:string,send:typeof fetch=window.fetch.bind(window)):HttpClient {
	const base=new URL(endpoint(raw));
	return {async request({url,method,headers,body,signal}){
		const target=new URL(url), suffix=target.pathname.slice(base.pathname.replace(/\/$/u,'').length);
		if(target.origin!==base.origin || target.username || target.password || target.hash ||
			!target.pathname.startsWith(base.pathname.replace(/\/$/u,'')) ||
			!['/git-upload-pack','/git-receive-pack','/info/refs'].includes(suffix))
			throw new Error(tr('Git 请求超出已确认的远端范围','Git request is outside the confirmed remote'));
		signal?.throwIfAborted();
		let payload:ArrayBuffer|undefined;
		if(body){
			const parts:Uint8Array[]=[];
			for await(const part of body)parts.push(part);
			const result=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));
			let offset=0;
			for(const part of parts){result.set(part,offset);offset+=part.length;}
			payload=result.buffer;
		}
		let response:Response;
		try{response=await send(url,{method,headers,body:payload,signal,redirect:'error',credentials:'omit',mode:'cors',referrerPolicy:'no-referrer'});}
		catch{throw new Error(tr('HTTPS 请求失败。请检查网络、服务器的 CORS 配置及是否存在重定向。','HTTPS request failed. Check connectivity, server CORS configuration, and redirects.'));}
		if(response.redirected || response.url && response.url!==target.href)throw new Error(tr('拒绝 HTTPS 重定向','HTTPS redirects are blocked'));
		const data=new Uint8Array(await response.arrayBuffer()), responseHeaders:Record<string,string>={};
		response.headers.forEach((v,k)=>{responseHeaders[k]=v;});
		return {url,method,headers:responseHeaders,statusCode:response.status,statusMessage:response.statusText,
			body:(async function*(){yield data;})()};
	}};
}
