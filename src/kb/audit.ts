import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tr } from '../i18n.ts';
import type { VaultDisk } from '../fs/vault.ts';
import type { Library } from './catalog.ts';
import { checkLinks } from './audit-links.ts';
import { inspectBase, inspectPage, readNote } from './audit-notes.ts';
import { within } from './audit-types.ts';
import type { AuditFinding, AuditNote, AuditReport } from './audit-types.ts';
import { inspectArticleSources } from './sources.ts';

const adminFiles = new Set(['README.md','AGENTS.md','LICENSES.md']);

async function inventory(disk: VaultDisk, location: string, report: AuditReport) {
	const files = new Set<string>(), directories = new Set<string>();
	async function visit(directory: string) {
		const relative = directory ? location + '/' + directory : location;
		const entries = await fs.readdir(await disk.path(relative), {withFileTypes:true});
		if (directory && entries.some(e => ['.git','kb.toml','kb-manager.json'].includes(e.name))) {
			report('review','nested-library',directory,tr('跳过独立知识库或 Git 仓库','Skipped nested knowledge base or Git repository'));
			return;
		}
		directories.add(directory);
		for (const entry of entries) {
			if (entry.name.startsWith('.') || ['node_modules','__pycache__'].includes(entry.name)) continue;
			const file = directory ? directory + '/' + entry.name : entry.name;
			try {
				if (entry.isSymbolicLink()) {
					report('review','linked-path',file,tr('跳过文件系统链接','Skipped filesystem link'));
				} else if (entry.isDirectory()) {
					await visit(file);
				} else if (entry.isFile()) {
					disk.validate(location + '/' + file);
					files.add(file);
				}
			} catch (error) {
				report('error','unreadable-path',file,String(error));
			}
		}
	}
	await visit('');
	return {files,directories};
}

/** Reads only an explicitly selected library. Findings never authorize an edit. */
export async function auditLibrary(disk: VaultDisk, lib: Library): Promise<AuditFinding[]> {
	const findings: AuditFinding[] = [];
	const report: AuditReport = (level,code,file,message) => { findings.push({level,code,file,message}); };
	if (lib.problem || lib.duplicate) {
		report('error','library-identity','',lib.problem || tr('知识库身份重复','Duplicate library identity'));
		return findings;
	}
	const {files,directories} = await inventory(disk,lib.location,report);
	const template = lib.identity?.template;
	const builtin = template?.id === 'llm-wiki' && template.version === '1';
	const adopted = template?.id === 'unknown' && template.version === 'unknown';
	const wiki = !template || builtin || adopted ? lib.mapping : undefined;
	if ((builtin || adopted) && !wiki) report('error','mapping-missing','kb.toml',tr('缺少知识库目录映射','Missing library path mapping'));
	const sources = [lib.mapping?.raw ?? 'raw',lib.mapping?.clippings ?? 'Clippings'];
	if (wiki) {
		for (const [role,name] of Object.entries(wiki)) {
			if (typeof name !== 'string') continue;
			const page = ['index','log','overview'].includes(role);
			if (!(page ? files : directories).has(name))
				report('error',page ? 'special-file-missing' : 'directory-missing',name,tr('缺少映射项目','Missing mapped item') + ': ' + role);
		}
		if (!wiki.clippings && [wiki.wiki,wiki.reports,wiki.templates,wiki.notes,wiki.raw].some(dir => within('Clippings',dir) || within(dir,'Clippings')))
			sources.splice(1,1);
		else if (!wiki.clippings && [...files].some(file => within(file,'Clippings')))
			report('review','clippings-unmapped','Clippings',tr('存在剪藏，但尚未配置 paths.clippings','Clippings exist without a paths.clippings mapping'));
	}
	async function readText(file: string) {
		if (!files.has(file)) throw new Error(tr('文件超出体检范围','File outside audit scope'));
		const fd = await fs.open(await disk.path(lib.location + '/' + file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await fd.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new Error(tr('需要独立常规文件','Expected a regular file with a single link'));
			return new TextDecoder('utf-8',{fatal:true}).decode(await fd.readFile());
		} finally { await fd.close(); }
	}
	const read = async (file: string) => readNote(await readText(file));
	const notes = new Map<string,AuditNote>();
	const articles = new Map<string,AuditNote>();
	for (const file of files) {
		if (sources.some(dir => within(file,dir))) continue;
		if (/\.base$/iu.test(file)) {
			try { inspectBase(file,await readText(file),wiki,report); }
			catch (error) { report('error','invalid-base',file,String(error)); }
		}
		if (!/\.md$/iu.test(file) || within(file,lib.mapping?.templates ?? 'templates')) continue;
		try {
			const note = await read(file);
			if (!wiki || !adminFiles.has(file)) notes.set(file,note);
			if (wiki && inspectPage(file,note,wiki,report)) articles.set(file,note);
		} catch (error) {
			report('error','invalid-metadata',file,String(error));
		}
	}
	const noMaterial = await checkLinks({
		location:lib.location, mapping:wiki, files, notes, articles:new Set(articles.keys()), report,
		readBody:async file => (notes.get(file) ?? await read(file)).body,
	});
	if (wiki) await inspectArticleSources(disk,lib.location,wiki,files,articles,noMaterial,read,report);
	return findings.sort((a,b) => a.level.localeCompare(b.level) || a.file.localeCompare(b.file) || a.code.localeCompare(b.code));
}
