import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import git from 'isomorphic-git';
import { segments } from '../fs/paths.ts';
import { VaultDisk, digest, statIfPresent, validateFolders } from '../fs/vault.ts';
import { initializeRepository, repository } from '../git/repository.ts';
import { identityFile, newIdentity, recheck } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { builtinTemplate, folderTemplate } from './template.ts';
import type { Template } from './template.ts';

export interface CreateInput {
	parent: string; name: string; displayName: string; description: string; source: string;
}
export interface CreatePreview {
	input: CreateInput; location: string; template: Template; signature: string; warnings: string[];
}

export async function ancestorWarnings(disk: VaultDisk, location: string): Promise<string[]> {
	const parts = segments(location);
	const warnings = [];
	for (let i=0; i<parts.length; i++) {
		const parent = i ? await disk.path(parts.slice(0,i).join('/')) : disk.root;
		if (await statIfPresent(path.join(parent,identityFile)) || await statIfPresent(path.join(parent,'kb.toml'))) {
			throw new Error('Nested knowledge base: ' + parts.slice(0,i).join('/'));
		}
		const metadata = await statIfPresent(path.join(parent,'.git'));
		if (!metadata) continue;
		if (!metadata.isDirectory()) { warnings.push('祖先目录包含特殊 Git 布局，请核对父仓跟踪与忽略规则。'); continue; }
		const repo = repository(parent);
		const filepath = parts.slice(i).join('/');
		const tracked = (await git.listFiles(repo)).some(file => file === filepath || file.startsWith(filepath+'/'));
		const ignored = await git.isIgnored({...repo,filepath});
		warnings.push('父仓 ' + (parts.slice(0,i).join('/') || '/') + '：' + (tracked ? '目标已被跟踪' : ignored ? '目标已被忽略' : '目标未被忽略'));
	}
	return warnings;
}

export async function previewCreate(disk: VaultDisk, config: Config, input: CreateInput, skeleton: Record<string,string>): Promise<CreatePreview> {
	validateFolders(disk,config.parents,config.templates);
	if (!config.parents.includes(input.parent) || segments(input.name).length !== 1 || !input.displayName.trim()) throw new Error('Invalid destination or display name');
	const location = input.parent + '/' + input.name;
	const dir = await disk.path(location);
	if (await statIfPresent(dir)) throw new Error('Destination exists: ' + location);
	const warnings = await ancestorWarnings(disk,location);
	const vars = {displayName:input.displayName, description:input.description, destination:location};
	let template: Template;
	if (!input.source) template = builtinTemplate(skeleton,vars);
	else {
		if (!config.templates.includes(input.source)) throw new Error('Select a registered template');
		template = await folderTemplate(await disk.path(input.source),disk.configDir,vars);
	}
	const signature = digest(JSON.stringify([input,template.id,template.version,template.entry,template.folders,template.excluded,warnings,
		template.files.map(file=>[file.name,digest(file.bytes)])]));
	return {input,location,template,signature,warnings};
}

export async function createLibrary(disk: VaultDisk, config: Config, preview: CreatePreview, skeleton: Record<string,string>) {
	const fresh = await previewCreate(disk,config,preview.input,skeleton);
	if (fresh.signature !== preview.signature) throw new Error('Template changed. Preview again.');
	const parent = await disk.path(fresh.input.parent);
	await fs.mkdir(parent,{recursive:true});
	const temporary = await fs.mkdtemp(path.join(parent,'.kb-create-'));
	const { template,input,location } = fresh;
	try {
		const manifest = newIdentity(input.displayName,input.description,{id:template.id,version:template.version},template.entry);
		for (const folder of template.folders) await fs.mkdir(path.join(temporary,folder),{recursive:true});
		for (const file of template.files) {
			const target = path.join(temporary,file.name);
			await fs.mkdir(path.dirname(target),{recursive:true});
			await fs.writeFile(target,file.bytes,{flag:'wx'});
			if (!input.source && file.name === 'knowledge.base') manifest.managed.push({path:file.name,fingerprint:digest(file.bytes),root:location});
		}
		await fs.writeFile(path.join(temporary,identityFile),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
		await initializeRepository(temporary);
		for (let attempt = 0; ; attempt++) {
			const destination = await disk.path(location);
			if (await statIfPresent(destination)) throw new Error('Destination exists: ' + location);
			try { await fs.rename(temporary,destination); break; }
			catch (error) {
				if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 4) throw error;
				await delay(50 * 2 ** attempt);
			}
		}
		return manifest;
	} finally {
		// A successful rename removes this temporary path. Keep interrupted work for inspection.
		if (await statIfPresent(temporary)) await fs.rm(temporary,{recursive:true});
	}
}

export async function adopt(disk: VaultDisk, config: Config, preview: Library, confirmedWarnings: string[]) {
	const lib = await recheck(disk,config,preview);
	if (lib.identity || !lib.mapping) throw new Error('Select a valid legacy knowledge base');
	if (JSON.stringify(await ancestorWarnings(disk,lib.location)) !== JSON.stringify(confirmedWarnings)) throw new Error('Parent repository changed');
	const manifest = newIdentity(path.posix.basename(lib.location),'',{id:'unknown',version:'unknown'},lib.mapping.index);
	const target = await disk.path(lib.location+'/'+identityFile);
	await fs.writeFile(target,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
	return manifest;
}
