/** Built locally; the page opens only when the user selects a link. */
export function hostingLinks(remote:string,branch?:string,message=''){
	const scp=/^(?:git@)?([\w.-]+):([\w./-]+)$/u.exec(remote);
	let url:URL;
	try{url=new URL(scp?'ssh://git@'+scp[1]+'/'+scp[2]:remote);}catch{return [];}
	const host=url.hostname.toLowerCase();
	if(!['github.com','gitlab.com','bitbucket.org'].includes(host) || !['https:','ssh:'].includes(url.protocol))return [];
	const path=url.pathname.replace(/\/$/u,'').replace(/\.git$/u,'');
	if(!/^\/(?:[\w.-]+\/)+[\w.-]+$/u.test(path))return [];
	const base='https://'+host+path,links:{label:string;url:string}[]=[];
	if(branch){
		const encoded=encodeURIComponent(branch);
		links.push({label:host==='gitlab.com'?'Merge request':'Pull request',url:base+(host==='github.com'?
			'/compare/'+encoded+'?expand=1':host==='gitlab.com'?'/-/merge_requests/new?merge_request[source_branch]='+encoded:
				'/pull-requests/new?source='+encoded)});
	}
	for(const number of new Set([...message.matchAll(/(?:^|\s|\()#(\d+)\b/gu)].map(m=>m[1]!)))
		links.push({label:'#'+number,url:base+(host==='gitlab.com'?'/-/issues/':'/issues/')+number});
	return links;
}
