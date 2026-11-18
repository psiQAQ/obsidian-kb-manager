import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {repository} from './repository.ts';
import {digest} from '../fs/vault.ts';
import {tr} from '../i18n.ts';

// Publish multi-key changes with Git's config.lock protocol.
export async function updateConfig(dir:string,expected:string,modify:(repo:ReturnType<typeof repository>)=>Promise<void>){
	const repo=repository(dir),config=path.join(repo.gitdir,'config'),lockPath=config+'.lock';
	const lock=await fs.open(lockPath,'wx');let shadow:string|undefined,published=false;
	try{
		const bytes=await fs.readFile(config),stat=await fs.stat(config);
		if(digest(bytes)!==expected)throw new Error(tr('仓库配置已变化','Repository configuration changed'));
		shadow=await fs.mkdtemp(path.join(repo.gitdir,'kb-config-'));
		const file=path.join(shadow,'config');
		await fs.writeFile(file,bytes,{mode:0o600});
		await modify({...repo,gitdir:shadow});
		await lock.chmod(stat.mode&0o777);
		await lock.writeFile(await fs.readFile(file));await lock.sync();await lock.close();
		await fs.rename(lockPath,config);published=true;
	}finally{
		if(!published){await lock.close();await fs.unlink(lockPath);}
		if(shadow){await fs.rm(path.join(shadow,'config'),{force:true});await fs.rmdir(shadow);}
	}
}
