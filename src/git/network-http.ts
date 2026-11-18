import {fromEnglish} from '../i18n.ts';
import {request as https} from 'node:https';
import {request as http} from 'node:http';
import type {HttpClient} from 'isomorphic-git';

export function endpoint(raw:string) {
	const url=new URL(raw);
	const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
	if(url.username || url.password || url.hash || url.search || !(url.protocol==='https:' || (loopback && url.protocol==='http:')))
		throw new Error(fromEnglish('Use an HTTPS repository URL without embedded credentials.','请使用不含凭据的 HTTPS 仓库 URL。'));
	return url.toString();
}

export function transport(remoteUrl:string):HttpClient{
	const origin=new URL(endpoint(remoteUrl)).origin;
	return {request:({url,method,headers,body,signal})=>new Promise((resolve,reject)=>{
		const target=new URL(url);
		if(target.origin!==origin){reject(new Error(fromEnglish('Remote origin changed','远端来源已变化')));return;}
		const request=target.protocol==='https:' ? https : http;
		const req=request(target,{method,headers,signal},res=>{
			const responseHeaders:Record<string,string>={};
			for(const [name,value] of Object.entries(res.headers))if(value!==undefined)responseHeaders[name]=Array.isArray(value)?value.join(','):value;
			resolve({url,method,statusCode:res.statusCode??500,statusMessage:res.statusMessage??'',headers:responseHeaders,
				body:res[Symbol.asyncIterator]() as AsyncIterableIterator<Uint8Array>});
		});
		req.on('error',reject);
		req.setTimeout(120000,()=>req.destroy(new Error(fromEnglish('Git HTTP request timed out','Git HTTP 请求超时'))));
		void (async()=>{
			if(body)for await(const chunk of body){
				if(!req.write(chunk))await new Promise<void>((done,fail)=>{
					const error=(e:Error)=>{req.off('drain',drain);fail(e);};
					const drain=()=>{req.off('error',error);done();};
					req.once('drain',drain).once('error',error);
				});
			}
			req.end();
		})().catch((error:Error)=>req.destroy(error));
	})};
}
