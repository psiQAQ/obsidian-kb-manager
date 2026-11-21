import * as fs from 'node:fs/promises';
import path from 'node:path';
import { VaultDisk } from '../../src/fs/vault.ts';
import { registryDataPath } from '../../src/registry/paths.ts';

export function vaultDisk(root,configDir) {
	const dataFile = path.join(root,registryDataPath(configDir));
	return new VaultDisk(root,configDir,{
		async load() {
			try { return JSON.parse(await fs.readFile(dataFile,'utf8')); }
			catch (error) { if (error.code === 'ENOENT') return null; throw error; }
		},
		async save(data) {
			await fs.mkdir(path.dirname(dataFile),{recursive:true});
			await fs.writeFile(dataFile,JSON.stringify(data,null,2)+'\n');
		},
	});
}
