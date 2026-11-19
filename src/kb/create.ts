import { tr, fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gitResult } from '../git/network-native.ts';
import { rebind } from './bindings.ts';
import { renameNewDirectory } from '../fs/publish.ts';
import { segments } from '../fs/paths.ts';
import { VaultDisk, digest, statIfPresent, validateFolders } from '../fs/vault.ts';
import { initializeRepository, repository } from '../git/repository.ts';
import { identityFile, newIdentity, recheck } from './catalog.ts';
import type { Config, Library } from './catalog.ts';
import { builtinTemplate, folderTemplate, kepanoSource, kepanoTemplate, kepanoBinding } from './template.ts';
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
			throw new Error(fromEnglish('Nested knowledge base: ','知识库不能嵌套：') + parts.slice(0,i).join('/'));
		}
		const metadata = await statIfPresent(path.join(parent,'.git'));
		if (!metadata) continue;
		if (!metadata.isDirectory()) { warnings.push(tr('祖先目录包含特殊 Git 布局，请核对父仓跟踪与忽略规则。','A parent directory has a special Git layout. Review its tracked files and ignore rules.')); continue; }
		const repo = repository(parent);
		const filepath = parts.slice(i).join('/');
		const reads = [path.join(repo.gitdir,'index'),path.join(repo.gitdir,'info'),path.join(repo.gitdir,'info','exclude')];
		for(let depth=i; depth<parts.length; depth++) reads.push(path.join(parent,...parts.slice(i,depth),'.gitignore'));
		let linked=false;
		for(const file of reads) {
			if((await statIfPresent(file))?.isSymbolicLink()){linked=true;break;}
		}
		if(linked){warnings.push(tr('父仓使用链接元数据，跟踪和忽略状态需人工核对。','The parent repository uses linked metadata. Check its tracked files and ignore rules manually.'));continue;}
		let tracked:boolean, ignored:boolean;
		try {
			tracked=(await gitResult(parent,['ls-files','-z','--',filepath])).stdout.length>0;
			ignored=(await gitResult(parent,['check-ignore','--quiet','--',filepath+'/'],{allowedExitCodes:[0,1]})).code===0;
		} catch {
			warnings.push(tr('父仓跟踪与忽略状态无法读取，请手动核对。','Unable to read parent tracking and ignore rules. Review them manually.'));
			continue;
		}
		warnings.push(tr('父仓 ','Parent repository ') + (parts.slice(0,i).join('/') || '/') + '：' + (tracked ? tr('目标已被跟踪','destination is tracked') : ignored ? tr('目标已被忽略','destination is ignored') : tr('目标未被忽略','destination is not ignored')));
	}
	return warnings;
}

export async function previewCreate(disk: VaultDisk, config: Config, input: CreateInput, skeleton: Record<string,string>): Promise<CreatePreview> {
	validateFolders(disk,config.parents,config.templates);
	if (!config.parents.includes(input.parent) || segments(input.name).length !== 1 || !input.displayName.trim()) throw new Error(fromEnglish('Invalid destination or display name','目标目录或显示名无效'));
	const location = input.parent + '/' + input.name;
	const dir = await disk.path(location);
	if (await statIfPresent(dir)) throw new Error(fromEnglish('Destination exists: ','目标已存在：') + location);
	const warnings = await ancestorWarnings(disk,location);
	const vars = {displayName:input.displayName, description:input.description, destination:location};
	let template: Template;
	if (!input.source) template = builtinTemplate(skeleton,vars);
	else if (input.source===kepanoSource) template=kepanoTemplate(skeleton,location);
	else {
		if (!config.templates.includes(input.source)) throw new Error(fromEnglish('Select a registered template','请选择已登记的模板'));
		template = await folderTemplate(await disk.path(input.source),disk.configDir,vars);
	}
	const signature = digest(JSON.stringify([input,template.id,template.version,template.overview,template.entry,template.folders,template.excluded,warnings,
		template.files.map(file=>[file.name,digest(file.bytes)])]));
	return {input,location,template,signature,warnings};
}

export async function createLibrary(disk: VaultDisk, config: Config, preview: CreatePreview, skeleton: Record<string,string>) {
	const fresh = await previewCreate(disk,config,preview.input,skeleton);
	if (fresh.signature !== preview.signature) throw new Error(fromEnglish('Template changed. Preview again.','模板已变化，请重新预览。'));
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
			if (input.source===kepanoSource && kepanoBinding(skeleton,file.name)) {
				manifest.managed.push({path:file.name,fingerprint:digest(file.bytes),root:location,role:'kepano-bindings'});
			} else if ((!input.source || template.overview) && file.name === 'knowledge.base') {
				manifest.managed.push({path:file.name,fingerprint:digest(file.bytes),root:location,
					role:input.source?'overview-bindings':undefined});
			}
		}
		await fs.writeFile(path.join(temporary,identityFile),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
		await initializeRepository(temporary);
		for (let attempt = 0; ; attempt++) {
			const destination = await disk.path(location);
			if (await statIfPresent(destination)) throw new Error(fromEnglish('Destination exists: ','目标已存在：') + location);
			try { await renameNewDirectory(temporary,destination); break; }
			catch (error) {
				if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 4) throw error;
				await delay(50 * 2 ** attempt);
			}
		}
		return manifest;
	} catch(error) {
		throw new Error(String(error)+tr('；未发布目录保留在 ','. The unpublished directory was retained at ')+path.basename(temporary)+tr('，可检查后重试。','. Inspect it before retrying.'));
	}
}

export async function legacyBinding(disk: VaultDisk, lib: Library) {
	if (lib.mapping?.wiki !== 'wiki') return undefined;
	const file = await disk.path(lib.location + '/knowledge.base');
	if (!(await statIfPresent(file))?.isFile()) return undefined;
	const bytes = await fs.readFile(file);
	try {
		const result = rebind(bytes.toString('utf8'), lib.location, lib.location);
		if (result.manual.length) return undefined;
		return digest(bytes);
	} catch { return undefined; }
}

export async function adopt(disk: VaultDisk, config: Config, preview: Library, confirmedWarnings: string[], bindingHash?:string) {
	const lib = await recheck(disk,config,preview);
	if (lib.identity || !lib.mapping) throw new Error(fromEnglish('Select a valid legacy knowledge base','请选择有效的旧知识库'));
	if (JSON.stringify(await ancestorWarnings(disk,lib.location)) !== JSON.stringify(confirmedWarnings)) throw new Error(fromEnglish('Parent repository changed','父仓库已变化'));
	const manifest = newIdentity(path.posix.basename(lib.location),'',{id:'unknown',version:'unknown'},lib.mapping.index);
	if (bindingHash) {
		if(await legacyBinding(disk,lib)!==bindingHash)throw new Error(tr('旧库绑定字段已变化','The legacy library binding changed'));
		manifest.managed.push({path:'knowledge.base',root:lib.location,fingerprint:bindingHash,role:'overview-bindings'});
	}
	const target = await disk.path(lib.location+'/'+identityFile);
	await fs.writeFile(target,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
	return manifest;
}
