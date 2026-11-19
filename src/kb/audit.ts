import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tr } from '../i18n.ts';
import type { VaultDisk } from '../fs/vault.ts';
import type { Library } from './catalog.ts';
import { checkIndex, checkLinks } from './audit-links.ts';
import { parseMarkdown } from './audit-markdown.ts';
import type { ParsedMarkdown } from './audit-markdown.ts';
import { inspectBase, inspectPage, isArticle, readNote } from './audit-notes.ts';
import { auditChecks, within } from './audit-types.ts';
import type { AuditCheck, AuditFinding, AuditNote, AuditReport, AuditResult } from './audit-types.ts';
import { inspectArticleSources, inspectLocalReferences } from './sources.ts';
import { checkOperations } from './audit-operations.ts';
import { examineBindings } from './maintenance.ts';

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

/** A read-only snapshot shared by the selected checks in a single run. */
export function createAuditSession(disk:VaultDisk, lib:Library, skeleton?:()=>Record<string,string>) {
	const rootProblems:AuditFinding[]=[];
	const unavailable=lib.problem || (lib.duplicate ? tr('知识库身份重复','Duplicate library identity') : '') ||
		(lib.missing ? tr('登记目录缺少 kb.toml','The registered folder has no kb.toml') : '');
	const mapping=lib.mapping;
	const templates=(file:string)=>mapping?.templates ? within(file,mapping.templates) : /^templates\//iu.test(file);
	const mappedFolders=mapping && [mapping.wiki,mapping.reports,mapping.templates,mapping.notes,mapping.raw];
	const clippingFallback=!!mapping && !mapping.clippings &&
		!mappedFolders?.some(dir=>dir && (within(dir,'Clippings') || within('Clippings',dir)));
	const sourceFolders=mapping ? [mapping.raw,mapping.clippings ?? (clippingFallback ? 'Clippings' : undefined)] : [];
	const sourceFile=(file:string)=>sourceFolders.some(dir=>dir && within(file,dir));
	const rootReport:AuditReport=(level,code,file,message)=>{rootProblems.push({level,code,file,message});};
	let scanned:ReturnType<typeof inventory> | undefined;
	const scan=()=>scanned??=inventory(disk,lib.location,rootReport);

	async function readText(file:string) {
		if (!(await scan()).files.has(file)) throw new Error(tr('文件超出体检范围','File outside audit scope'));
		const fd = await fs.open(await disk.path(lib.location + '/' + file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await fd.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new Error(tr('需要独立常规文件','Expected a regular file with a single link'));
			return new TextDecoder('utf-8',{fatal:true}).decode(await fd.readFile());
		} finally { await fd.close(); }
	}
	const parsedNotes=new Map<string,Promise<AuditNote>>();
	const read=(file:string)=>{
		let note=parsedNotes.get(file);
		if(!note) {note=readText(file).then(readNote); parsedNotes.set(file,note);}
		return note;
	};
	let notes:ReturnType<typeof readContentNotes> | undefined;
	async function readContentNotes() {
		const valid=new Map<string,AuditNote>(), invalid=new Map<string,string>();
		for(const file of (await scan()).files) {
			if(!/\.md$/iu.test(file) || templates(file) || sourceFile(file) || mapping && adminFiles.has(file))continue;
			try{valid.set(file,await read(file));}
			catch(error){invalid.set(file,String(error));}
		}
		return {valid,invalid};
	}
	const loadNotes=()=>notes??=readContentNotes();
	const parsedBodies=new Map<string,ParsedMarkdown>();
	const parsed=(file:string,note:AuditNote)=>{
		let body=parsedBodies.get(file);
		if(!body){body=parseMarkdown(note.body);parsedBodies.set(file,body);}
		return body;
	};

	async function runCheck(check:AuditCheck):Promise<AuditResult>{
		const findings:AuditFinding[]=[], repairs:AuditResult['repairs']=[];
		const report:AuditReport=(level,code,file,message)=>{findings.push({level,code,file,message});};
		const result=(status:AuditResult['status'],reason?:string):AuditResult=>({check,status,findings,repairs,reason});
		try {
			if(unavailable){
				if(check!=='identity')return result('not-applicable',unavailable);
				report('error','library-identity','kb.toml',unavailable);
				return result('findings');
			}
			if(check==='index' && !mapping)
				return result('not-applicable',tr('此库没有内容目录映射','This library has no content path mapping'));
			const {files,directories}=await scan();
			if(check==='identity'){
				findings.push(...rootProblems);
				const entry=lib.identity?.entry;
				if(entry && !files.has(entry))report('error','entry-missing',entry,tr('缺少入口文件','Missing entry file'));
				for(const [role,name] of Object.entries(mapping??{})){
					if(typeof name!=='string')continue;
					const page=['index','log','overview'].includes(role);
					if(!(page ? files : directories).has(name))
						report('error',page ? 'special-file-missing' : 'directory-missing',name,tr('缺少映射项目','Missing mapped item') + ': ' + role);
				}
			}
			if(check==='bindings'){
				const bases=[...files].filter(file=>/\.base$/iu.test(file) && !sourceFile(file));
				const managed=!!lib.identity?.managed.length;
				if(!bases.length && !managed) return result('not-applicable',tr('此库没有 Base 或受管绑定','This library has no Base or managed binding'));
				for(const file of bases){
					try{inspectBase(file,await readText(file),!templates(file),report);}
					catch(error){report('error','invalid-base',file,String(error));}
				}
				if(managed && skeleton){
					const binding=await examineBindings(disk,lib,skeleton());
					for(const message of binding.manual) report('review','managed-binding','',message);
					repairs.push(...binding.repairs);
				}
			}
			if(check==='properties' || check==='links' || check==='index' || check==='ingestion'){
				const {valid,invalid}=await loadNotes();
				if(check==='properties'){
					for(const [file,message] of invalid)report('error','invalid-metadata',file,message);
					for(const [file,note] of valid)inspectPage(file,note,mapping,report);
				}
				if(check==='links')await checkLinks({location:lib.location,mapping,files,notes:valid,parsed,readBody:async file=>(await read(file)).body,report});
				if(check==='ingestion' && !mapping){
					if(![...valid.values()].some(({metadata:m})=>m.type==='operation' || 'sources' in m))
						return result('not-applicable',tr('此库没有来源映射、来源属性或操作记录','This library has no source mapping, source properties, or operation notes'));
					checkOperations(lib.location,undefined,files,valid,parsed,report);
					inspectLocalReferences(lib.location,files,valid,report);
				}
				if(mapping && (check==='index' || check==='ingestion')){
					const articles=new Map([...valid].filter(([file,note])=>isArticle(file,note,mapping)));
					if(check==='index'){
						const index=valid.get(mapping.index);
						if(!index)return result('failed',tr('无法读取映射的索引页','The mapped index could not be read')+' · '+mapping.index);
						checkIndex(mapping,parsed(mapping.index,index),files,articles,report);
					}else{
						if(clippingFallback && [...files].some(file=>within(file,'Clippings')))
							report('review','clippings-unmapped','Clippings',tr('存在剪藏，但尚未配置 paths.clippings','Clippings exist without a paths.clippings mapping'));
						const noMaterial=checkOperations(lib.location,mapping,files,valid,parsed,report);
						await inspectArticleSources(disk,lib.location,mapping,files,articles,noMaterial,read,report);
					}
				}
			}
			findings.sort((a,b)=>a.level.localeCompare(b.level) || a.file.localeCompare(b.file) || a.code.localeCompare(b.code));
			const checked=result(findings.length || repairs.length ? 'findings' : 'clean');
			if(check==='identity')checked.details=[
				tr('Git 状态','Git status')+' · '+({local:tr('独立仓库','Local repository'),missing:tr('未初始化','Uninitialized'),special:tr('特殊布局','Special layout')})[lib.git],
				lib.identity ? tr('知识库 ID','Library ID')+' · '+lib.identity.id : tr('旧知识库尚未接管','Legacy library pending adoption'),
			];
			return checked;
		}catch(error){return result('failed',String(error));}
	}

	return {run:(selection:readonly AuditCheck[])=>Promise.all([...new Set(selection)].map(runCheck))};
}

export async function auditLibrary(disk:VaultDisk, lib:Library):Promise<AuditFinding[]> {
	const reports=await createAuditSession(disk,lib).run(auditChecks);
	return reports.flatMap(report=>report.findings).sort((a,b)=>a.level.localeCompare(b.level) || a.file.localeCompare(b.file) || a.code.localeCompare(b.code));
}
