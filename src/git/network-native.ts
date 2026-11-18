import {fromEnglish} from '../i18n.ts';
import {execFile} from 'node:child_process';
import * as path from 'node:path';
import {guardGit} from './guard.ts';

const allowedConfig = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks|precomposeunicode)|user\.(name|email)|remote\.[\w.-]+\.(url|fetch)|branch\..+\.(remote|merge)|init\.defaultbranch)$/iu;

// Child processes receive no inherited Git overrides, credential helpers or shell.
function execute(dir:string, args:string[], auth?:string,stdin?:string): Promise<string> {
	const env:NodeJS.ProcessEnv = {};
	for (const key of ['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','LANG','LC_ALL']){
		const value = process.env[key];
		if(value) env[key] = value;
	}
	Object.assign(env,{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',
		GIT_NO_REPLACE_OBJECTS:'1',GIT_LITERAL_PATHSPECS:'1',GIT_ALLOW_PROTOCOL:'http:https'});
	if(auth) Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: Basic '+auth});
	const prefix = ['--git-dir='+path.join(dir,'.git'),'--work-tree='+dir,'-c','core.hooksPath=/dev/null',
		'-c','http.followRedirects=false','-c','protocol.ext.allow=never','-c','gc.auto=0','-c','core.fsmonitor=false'];
	return new Promise((resolve,reject)=>{
		const child=execFile('git',[...prefix,...args],{
			cwd:path.dirname(process.execPath),env,windowsHide:true,timeout:120000,maxBuffer:16*1024*1024
		},(error,stdout,stderr)=>{
			if(error) reject(new Error((stderr || error.message).replace(/Authorization:[^\r\n]*/giu,'[redacted]').slice(0,1500)));
			else resolve(stdout);
		});
		if(stdin!==undefined){
			child.stdin?.on('error',(error:NodeJS.ErrnoException)=>{if(error.code!=='EPIPE')reject(error);});
			child.stdin?.end(stdin);
		}
	});
}

export async function checkedNative(dir:string,merging:boolean|'resolved'=false) {
	await guardGit(dir,new Set(),false,merging);
	const raw=await execute(dir,['config','--local','--no-includes','--null','--list']);
	for(const item of raw.split('\0').filter(Boolean)){
		const key=item.split('\n')[0] ?? '';
		if(!allowedConfig.test(key))throw new Error(fromEnglish('Unsupported native Git configuration: ','原生 Git 配置不受支持：')+key);
	}
	return (args:string[],auth?:string,stdin?:string)=>execute(dir,args,auth,stdin);
}

export async function blameLine(dir:string,file:string,line:number) {
	if(!Number.isSafeInteger(line)||line<1 || path.isAbsolute(file) || /[\\:\0]/u.test(file) ||
		file.split('/').some(p=>!p || p==='.' || p==='..' || p.toLowerCase()==='.git')) throw new Error(fromEnglish('Invalid file or line','文件或行号无效'));
	const run=await checkedNative(dir);
	const raw=await run(['blame','--line-porcelain','-L',line+','+line,'--',file]);
	const value=(name:string)=>raw.split('\n').find(s=>s.startsWith(name+' '))?.slice(name.length+1) ?? '';
	return {oid:raw.slice(0,40),author:value('author'),timestamp:Number(value('author-time')),summary:value('summary')};
}
