import { fromEnglish } from '../i18n.ts';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { segments } from '../fs/paths.ts';
import { digest, key, statIfPresent } from '../fs/vault.ts';
import { declaration, excludedNames, renderBase } from './template-core.ts';
import type { Template, TemplateFile, Variables } from './template-core.ts';
import {instanceText} from './instance-text.ts';
import {verifyDeclaration} from './template-declaration.ts';
export * from './template-core.ts';

export async function folderTemplate(root: string, configDir: string, vars: Variables): Promise<Template> {
	const specName = 'kb-template.json';
	const specPath = path.join(root, specName);
	const specStat = await statIfPresent(specPath);
	if (specStat && !specStat.isFile()) throw new Error(fromEnglish('Expected a regular template declaration','模板声明必须为常规文件'));
	const spec = specStat ? declaration(await fs.readFile(specPath,'utf8')) : {};
	const files: TemplateFile[] = [], folders: string[] = [], excluded: string[] = [];
	const sourceFiles: string[] = [];
	const rootSlots:Record<string,number[]>={};
	async function walk(relative: string) {
		const directory = path.join(root,relative);
		const names = (await fs.readdir(directory)).sort();
		if (new Set(names.map(key)).size !== names.length) throw new Error(fromEnglish('Template name collision: ','模板路径名称冲突：') + relative);
		for (const name of names) {
			const file = relative ? relative + '/' + name : name;
			const absolute = path.join(root,file);
			if (key(name) === 'kb-manager.json') throw new Error(fromEnglish('Template contains a knowledge base identity: ','模板含知识库身份文件：') + file);
			if (key(name) === key(configDir) || excludedNames.has(key(name)) ||
				(name.startsWith('.') && !['.gitignore','.gitkeep'].includes(name) && !spec.hidden?.includes(file))) {
				excluded.push(file); continue;
			}
			segments(name.startsWith('.') ? 'hidden' + name : name);
			const stat = await fs.lstat(absolute);
			if (stat.isDirectory()) { folders.push(file); await walk(file); continue; }
			if (!stat.isFile()) throw new Error(fromEnglish('Expected a regular template file: ','模板项必须为常规文件：') + file);
			let bytes: Uint8Array = await fs.readFile(absolute);
			sourceFiles.push(file + ':' + digest(bytes));
			if (file === 'knowledge.base' && spec.managed?.length) {
				const original = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
				bytes = Buffer.from(renderBase(original,vars.destination));
			}
			const fields = spec.text?.[file];
			if (fields) {
				const original = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
				const rendered=instanceText(file,original,fields,vars);
				bytes=Buffer.from(rendered.content);
				if(rendered.offsets.length)rootSlots[file]=rendered.offsets;
			}
			files.push({name:file, bytes});
		}
	}
	await walk('');
	verifyDeclaration(spec,files.map(file=>file.name),folders);
	return { id:spec.id ?? 'folder', version:spec.version ?? digest(JSON.stringify([spec,folders,sourceFiles])),
		paths:spec.paths, overview:!!spec.managed?.length, entry:spec.entry, rootSlots, files, folders, excluded,
		suggestedExcludedFolders:spec.suggestedExcludedFolders,defaultExcludedFolders:spec.defaultExcludedFolders,managedFiles:spec.managedFiles };
}
