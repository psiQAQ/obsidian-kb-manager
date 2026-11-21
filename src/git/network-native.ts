import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {findLocalExecutable} from '../fs/local-executable.ts';
import {guardGit} from './guard.ts';
import {fromEnglish,tr} from '../i18n.ts';

let configured='';
let configuredVault:string|undefined;
export function configureGitExecutable(value:string,vaultRoot?:string){
	if(value && (!path.isAbsolute(value)||/[\r\n\0]/u.test(value)))throw new Error(tr('请输入 Git 可执行文件的绝对路径','Enter an absolute Git executable path'));
	configured=value;
	configuredVault=vaultRoot;
}

async function program(name:'git'|'ssh',override:string,roots:readonly (string|undefined)[]){
	const binary=await findLocalExecutable(name,roots,override);
	if(binary)return binary;
	throw new Error(name==='git'
		? tr('找不到可用的系统 Git。请在 Vault 外安装 Git，或在插件高级设置中指定其绝对路径。','System Git was not found. Install Git outside the vault or set its absolute path in Advanced settings.')
		: tr('找不到 Vault 外可用的 OpenSSH 客户端','OpenSSH executable outside the vault was not found'));
}

function environment():NodeJS.ProcessEnv{
	const env:NodeJS.ProcessEnv={};
	for(const key of ['PATH','HOME','XDG_CONFIG_HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','SystemRoot','WINDIR','COMSPEC',
		'TEMP','TMP','TMPDIR','LANG','LC_ALL','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData',
		'GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_CONFIG_NOSYSTEM','SSH_AUTH_SOCK','GNOME_KEYRING_CONTROL','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY',
		'https_proxy','http_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR']){
		if(process.env[key])env[key]=process.env[key];
	}
	return Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_OPTIONAL_LOCKS:'0',
		GIT_NO_REPLACE_OBJECTS:'1',GIT_LITERAL_PATHSPECS:'1',GIT_ALLOW_PROTOCOL:'http:https:ssh',GIT_PAGER:'',PAGER:''});
}

async function execute(file:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,input?:Buffer|string,allowed=[0]){
	return new Promise<{stdout:Buffer;code:number}>((resolve,reject)=>{
		const child=execFile(file,args,{cwd,env,encoding:'buffer',windowsHide:true,shell:false,timeout:120000,maxBuffer:64*1024*1024},(error,stdout,stderr)=>{
			const code=error ? error.code : 0;
			if(typeof code==='number' && allowed.includes(code)){resolve({stdout,code});return;}
			const reason=stderr.toString().toLowerCase();
			const category=reason.includes('authentication')||reason.includes('could not read username')||reason.includes('403')||reason.includes('permission denied')
				?tr('认证失败','authentication failed')
				:reason.includes('host key')?tr('SSH 主机密钥校验失败','SSH host key verification failed')
				:reason.includes('non-fast-forward')||reason.includes('fetch first')?tr('远端不能快进','remote rejected a non-fast-forward update')
				:reason.includes('conflict')?tr('存在冲突，请检查本库状态','conflict, inspect the library status')
				:tr('命令未完成','command did not complete');
			reject(new Error('Git · '+category+' ('+(typeof code==='number'?code:'process')+')'));
		});
		child.stdin?.on('error',(error:NodeJS.ErrnoException)=>{if(error.code!=='EPIPE')reject(new Error('Git stdin · '+String(error.code)));});
		child.stdin?.end(input);
	});
}

export async function probeGitExecutable(value=configured){
	if(value && !path.isAbsolute(value))throw new Error(tr('需要绝对路径','Absolute path required'));
	const binary=await program('git',value,[configuredVault]);
	const result=await execute(binary,['--version'],path.dirname(binary),environment());
	const version=result.stdout.toString().trim();
	if(!/^git version \d+\.\d+(?:\.[\w.-]+)?$/u.test(version))throw new Error(tr('程序未返回 Git 版本','Executable did not report a Git version'));
	return version;
}

const allowedConfig=/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks|precomposeunicode|autocrlf|safecrlf|eol|quotepath)|(?:user|author|committer)\.(name|email)|remote\.[\w.-]+\.(url|pushurl|fetch)|branch\..+\.(remote|merge|rebase|description)|init\.defaultbranch)$/iu;
const checkedConfigs=new Map<string,string>();
export interface RunOptions{
	stdin?:Uint8Array|string; indexFile?:string; allowedExitCodes?:number[];
	author?:{name:string;email:string;date:string};
	network?:{url:string;basic?:string};
	vaultRoot?:string;
}
const defaults=['-c','core.hooksPath=/dev/null','-c','http.followRedirects=false','-c','protocol.ext.allow=never',
	'-c','gc.auto=0','-c','maintenance.auto=false','-c','core.fsmonitor=false','-c','submodule.recurse=false','-c','commit.gpgsign=false'];
export async function gitResult(dir:string|undefined,args:string[],options:RunOptions={}){
	const roots=[configuredVault,options.vaultRoot,dir];
	const binary=await program('git',configured,roots);
	const cwd=dir??path.dirname(binary),env=environment();
	if(args.length===2 && args[0]==='var' && (args[1]==='GIT_AUTHOR_IDENT' || args[1]==='GIT_COMMITTER_IDENT')){
		for(const key of ['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL']){
			const value=process.env[key];
			if(value!==undefined)env[key]=value;
		}
	}
	if(args[0]==='check-ignore')delete env.GIT_LITERAL_PATHSPECS;
	const base=dir?['--git-dir='+path.join(dir,'.git'),'--work-tree='+dir]:[];
	if(dir){
		const gd=path.join(dir,'.git'),file=path.join(gd,'config');
		const gdStat=await fs.lstat(gd).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
		if(gdStat && !gdStat.isDirectory())throw new Error(tr('需要库内独立 Git 目录','Expected a standalone Git directory'));
		const stat=await fs.lstat(file).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;});
		const identityQuery=args[0]==='config' && ['user.name','user.email'].includes(args[args.length-1]??'') && args.includes('--get-all') && args.slice(1,-1).every(a=>['--show-scope','--show-origin','--null','--get-all','--includes'].includes(a));
		if(stat && (!stat.isFile() || stat.nlink!==1))throw new Error(tr('Git 配置不是独立普通文件','Git config is not a standalone regular file'));
		if(stat && !identityQuery){
			const bytes=await fs.readFile(file),fingerprint=createHash('sha256').update(bytes).digest('hex');
			if(checkedConfigs.get(file)!==fingerprint){
				const result=await execute(binary,[...base,...defaults,'config','--file','-','--no-includes','--null','--name-only','--list'],cwd,env,bytes);
				for(const key of result.stdout.toString().split('\0').filter(Boolean))if(!allowedConfig.test(key))
					throw new Error(tr('此库包含需要手动核对的 Git 配置','This repository has Git configuration that needs manual review'));
				if(checkedConfigs.size>=128)checkedConfigs.clear();
				checkedConfigs.set(file,fingerprint);
			}
		}
	}
	if(options.indexFile){
		if(!dir || !path.isAbsolute(options.indexFile) || !path.resolve(options.indexFile).startsWith(path.join(dir,'.git')+path.sep))throw new Error('Invalid private index');
		env.GIT_INDEX_FILE=options.indexFile;
	}
	if(options.author)Object.assign(env,{GIT_AUTHOR_NAME:options.author.name,GIT_AUTHOR_EMAIL:options.author.email,GIT_AUTHOR_DATE:options.author.date});
	const extra:string[]=[];
	if(options.network){
		const {url,basic}=options.network;
		if(basic){
			if(!url.startsWith('https://'))throw new Error(tr('备用令牌只可用于 HTTPS','Fallback tokens require HTTPS'));
			env.GIT_CONFIG_COUNT='1';env.GIT_CONFIG_KEY_0='http.'+url+'.extraHeader';env.GIT_CONFIG_VALUE_0='Authorization: Basic '+basic;
			extra.push('-c','credential.helper=','-c','http.'+url+'.sslVerify=true');
		}
		if(/^https?:\/\//u.test(url))extra.push('-c','http.'+url+'.followRedirects=false');
		else{
			const ssh=await program('ssh','',roots);
			env.GIT_SSH_VARIANT='ssh';env.GIT_SSH_COMMAND="'"+ssh.replace(/\\/gu,'/').replace(/'/gu,"'\\''")+"' -o BatchMode=yes -o StrictHostKeyChecking=yes";
		}
	}
	return execute(binary,[...base,...defaults,...extra,...args],cwd,env,
		typeof options.stdin==='string'?options.stdin:options.stdin&&Buffer.from(options.stdin),options.allowedExitCodes);
}

export async function sshRoute(url:URL,dir?:string){
	const binary=await program('ssh','',[configuredVault,dir]),host=(url.username?url.username+'@':'')+url.hostname;
	const result=await execute(binary,['-G','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',...(url.port?['-p',url.port]:[]),'--',host],
		path.dirname(binary),environment());
	const lines=result.stdout.toString().split(/\r?\n/u);
	const selected=lines.filter(l=>/^(?:hostname|port|user|hostkeyalias|proxyjump|proxycommand|canonicalizehostname|identityfile|identitiesonly) /iu.test(l));
	const hostname=selected.find(l=>l.startsWith('hostname '))?.slice(9),port=selected.find(l=>l.startsWith('port '))?.slice(5),
		user=selected.find(l=>l.startsWith('user '))?.slice(5);
	if(!hostname || !port || !user)throw new Error(tr('未能确定 SSH 目标','Could not resolve SSH destination'));
	return {display:user+'@'+hostname+':'+port,signature:selected.join('\n')};
}
export async function checkedNative(dir:string,merging:boolean|'resolved'=false){
	await guardGit(dir,new Set(),false,merging);
	return async(args:string[],_auth?:undefined,stdin?:string)=>(await gitResult(dir,args,{stdin})).stdout.toString();
}
export async function blameLine(dir:string,file:string,line:number){
	if(!Number.isSafeInteger(line)||line<1 || path.isAbsolute(file) || /[\\:\0]/u.test(file) ||
		file.split('/').some(p=>!p || p==='.' || p==='..' || p.toLowerCase()==='.git')) throw new Error(fromEnglish('Invalid file or line','文件或行号无效'));
	const run=await checkedNative(dir);
	const raw=await run(['blame','--line-porcelain','-L',line+','+line,'--',file]);
	const value=(name:string)=>raw.split('\n').find(s=>s.startsWith(name+' '))?.slice(name.length+1) ?? '';
	return {oid:raw.slice(0,40),author:value('author'),timestamp:Number(value('author-time')),summary:value('summary')};
}
