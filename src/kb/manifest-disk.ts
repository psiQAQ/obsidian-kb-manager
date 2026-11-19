import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tr } from '../i18n.ts';
import { digest, statIfPresent } from '../fs/vault.ts';
import type { VaultDisk } from '../fs/vault.ts';
import { identityFile, readManifest } from './identity-core.ts';

async function removeTemporary(file:string) {
	try {await fs.unlink(file);}
	catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}

export async function readManifestFile(filename:string) {
	const stat=await statIfPresent(filename);
	if(!stat?.isFile() || stat.nlink!==1)
		throw new Error(tr('kb.toml 必须为独立常规文件','kb.toml must be a regular file with a single link'));
	const file=await fs.open(filename,constants.O_RDONLY | (constants.O_NOFOLLOW??0));
	try {
		const current=await file.stat();
		if(current.dev!==stat.dev || current.ino!==stat.ino || !current.isFile() || current.nlink!==1)
			throw new Error(tr('读取时清单已变化','The manifest changed during reading'));
		const bytes=await file.readFile();
		return {raw:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),signature:digest(bytes),mode:current.mode};
	} finally {await file.close();}
}

export async function replaceLibraryManifest(disk:VaultDisk, location:string, before:string, after:string) {
	readManifest(after);
	const name=location+'/'+identityFile;
	const filename=await disk.path(name);
	const initial=await readManifestFile(filename);
	const changed=()=>new Error(tr('清单已变化，请重新预览','Manifest changed. Preview again'));
	if(initial.signature!==before)throw changed();
	if(after===initial.raw)return;
	const temporary=path.join(path.dirname(filename),'.kb-manifest-'+randomUUID()+'.tmp');
	const file=await fs.open(temporary,'wx',initial.mode & 0o777);
	try {
		try {await file.writeFile(after);await file.sync();}
		finally {await file.close();}
		if(await disk.path(name)!==filename || (await readManifestFile(filename)).signature!==before)throw changed();
		await fs.rename(temporary,filename);
	} finally {await removeTemporary(temporary);}
}
