import type {DataAdapter} from 'obsidian';
import {segments} from '../fs/segments.ts';
import {tr} from '../i18n.ts';

export type Disk=Pick<DataAdapter,'stat'|'list'|'read'|'readBinary'|'write'|'writeBinary'|'mkdir'|'rmdir'|'remove'|'copy'|'rename'>;
export const key=(s:string)=>s.normalize('NFC').toLowerCase();
export const bytes=(s:string)=>new TextEncoder().encode(s);
export const decode=(data:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
export const buffer=(data:Uint8Array)=>Uint8Array.from(data).buffer;
export async function hash(data:Uint8Array|string){
	const array=typeof data==='string'?bytes(data):data;
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer(array))),b=>b.toString(16).padStart(2,'0')).join('');
}
export function component(name:string){
	if(!name || name==='.' || name==='..' || name.includes('/') || /^git~\d+$/iu.test(name))throw new Error(tr('不安全的路径','Unsafe path')+': '+name);
	segments(name.startsWith('.')?'hidden'+name:name);
	return name;
}
export function relative(name:string,configDir:string,git=false){
	const parts=name.split('/');
	for(const [i,p] of parts.entries()){
		component(p);
		if(key(p)===key(configDir) || (key(p)==='.git' && (!git || i!==0 || p!=='.git')))throw new Error(tr('保留目录','Reserved directory')+': '+p);
	}
	return name;
}
export function settingsPaths(parents:string[],templates:string[],configDir:string){
	if(!parents.length)throw new Error(tr('请登记知识库父目录','Choose a library parent'));
	const paths=[...parents,...templates].map(p=>{segments(p);relative(p,configDir);return key(p)+'/';});
	if(paths.some((p,i)=>paths.some((q,j)=>i!==j && p.startsWith(q))))throw new Error(tr('设置目录重叠','Configured directories overlap'));
}
export async function children(disk:Disk,dir:string){
	const data=await disk.list(dir), seen=new Set<string>();
	for(const value of [...data.folders,...data.files]){
		const prefix=dir?dir+'/':'';
		if(!value.startsWith(prefix))throw new Error(tr('适配器返回越界路径','Adapter returned an outside path'));
		const name=value.slice(prefix.length);
		component(name);
		if(seen.has(key(name)))throw new Error(tr('路径名称冲突','Path name collision')+': '+value);
		seen.add(key(name));
	}
	return data;
}
export async function checkSpelling(disk:Disk,path:string){
	let parent='';
	for(const name of path.split('/')){
		const data=await children(disk,parent);
		const expected=parent?parent+'/'+name:name;
		const alias=[...data.files,...data.folders].find(p=>key(p)===key(expected));
		if(alias && alias!==expected)throw new Error(tr('路径名称冲突','Path spelling collision')+': '+alias);
		if(!alias)return;
		parent=expected;
	}
}
export async function ensureFolder(disk:Disk,path:string){
	let parent='';
	for(const name of path.split('/')){
		parent=parent?parent+'/'+component(name):component(name);
		const stat=await disk.stat(parent);
		if(!stat)await disk.mkdir(parent);
		else if(stat.type!=='folder')throw new Error(tr('目录位置已被占用','Folder path is occupied')+': '+parent);
	}
}

function fsError(code:string,path:string){return Object.assign(new Error(code+': '+path),{code});}

// Git receives a virtual root. It cannot discover the vault Git repository or a sibling.
export function mobileRepo(disk:Disk,root:string,configDir:string){
	relative(root,configDir);
	const dir='kb',gitdir=dir+'/.git';
	function resolve(path:string){
		if(path===dir || path===dir+'/.')return root;
		if(typeof path!=='string' || !path.startsWith(dir+'/'))throw fsError('EACCES',String(path));
		return root+'/'+relative(path.slice(dir.length+1),configDir,true);
	}
	async function stat(path:string){
		const st=await disk.stat(resolve(path));
		if(!st)throw fsError('ENOENT',path);
		const file=st.type==='file';
		return {size:st.size,ctimeMs:st.ctime,mtimeMs:st.mtime,ctime:new Date(st.ctime),mtime:new Date(st.mtime),
			uid:0,gid:0,dev:0,ino:0,mode:file?0o100644:0o040755,
			isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>false};
	}
	const promises={
		readFile:async(path:string,opt?:string|{encoding?:string})=>{
			const loc=resolve(path),st=await stat(path);
			if(st.isDirectory())throw fsError('EISDIR',path);
			return (typeof opt==='string'?opt:opt?.encoding)==='utf8'?disk.read(loc):new Uint8Array(await disk.readBinary(loc));
		},
		writeFile:async(path:string,data:string|Uint8Array)=>{
			const loc=resolve(path), parent=loc.slice(0,loc.lastIndexOf('/'));
			if(!(await disk.stat(parent)))throw fsError('ENOENT',parent);
			if(typeof data==='string')await disk.write(loc,data);else await disk.writeBinary(loc,buffer(data));
		},
		mkdir:async(path:string)=>{
			const loc=resolve(path);
			if(await disk.stat(loc))throw fsError('EEXIST',loc);
			await disk.mkdir(loc);
		},
		readdir:async(path:string)=>{
			const loc=resolve(path);
			if(!(await stat(path)).isDirectory())throw fsError('ENOTDIR',path);
			const res=await children(disk,loc);
			return [...res.files,...res.folders].map(p=>p.slice(loc.length+1));
		},
		unlink:async(path:string)=>{await stat(path);await disk.remove(resolve(path));},
		rmdir:async(path:string)=>{await stat(path);await disk.rmdir(resolve(path),false);},
		stat,lstat:stat,readlink:async()=>{throw fsError('ENOTSUP','readlink');},
		symlink:async()=>{throw fsError('ENOTSUP','symlink');},
	};
	return {fs:{promises},dir,gitdir};
}
