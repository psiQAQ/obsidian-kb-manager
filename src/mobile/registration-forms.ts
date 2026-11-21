import {Setting} from 'obsidian';
import {tr} from '../i18n.ts';
import {identityFile,readManifest,withManifestIgnore,writeIdentity} from '../kb/identity-core.ts';
import {Dialog} from '../ui/dialog.ts';
import {registryPathField} from '../ui/registry-path-field.ts';
import {registryIgnoreFor,withIgnoreRule} from '../registry/paths.ts';
import {applyLibraryBindings,bindingLines,previewBindings,resumeLibraryBindings} from './bindings.ts';
import {newIdentity} from './catalog.ts';
import {checkSpelling,replaceText} from './disk.ts';
import {confirm} from './forms.ts';
import type MobilePlugin from './plugin.ts';
import {assignMobileCopyId,discoverMobile,previewMobileRegistryIgnore,registerMobile,registryIgnoreLines,scanMobile,selectMobileManifest,updateMobileRegistry} from './registration.ts';
import type {Library} from './registration.ts';

function manifestLines(lib:Library){
	const identity=lib.identity,entry=identity?.entry??lib.mapping?.index;
	return [lib.location+'/'+identityFile,identity?identity.displayName+' · '+identity.id:tr('仅有目录映射，可按新库接管','Contains path mapping. Available for adoption.'),
		...[tr('首页 · ','Homepage · ')+(entry?lib.location+'/'+entry:tr('未设置','None'))],
		...Object.entries(lib.preferences??{}).map(([key,value])=>'preferences.'+key+' = '+String(value))];
}

export async function registryIgnoreForm(plugin:MobilePlugin){
	const {disk,configDir}=plugin.ctx,path='.gitignore',rule=registryIgnoreFor(configDir);
	await checkSpelling(disk,path);
	const before=(await disk.stat(path))?await disk.read(path):undefined;
	const after=withIgnoreRule(before??null,rule);
	if(after===before){
		const dlg=new Dialog(plugin.app,tr('Vault Git 忽略规则','Vault Git ignore rule'));
		dlg.lines([path,rule,tr('规则已存在','Rule already present')]);dlg.open();return;
	}
	confirm(plugin,tr('写入 Vault Git 忽略规则','Write the Vault Git ignore rule'),[path,rule],async()=>{
		await plugin.catalogWrite(()=>replaceText(disk,path,before,after));
	});
}

export function manifestForm(plugin:MobilePlugin,replace?:string){
	const dlg=new Dialog(plugin.app,replace?tr('重新定位知识库','Locate a library'):tr('登记知识库清单','Register a library manifest'));
	if(replace)dlg.lines([replace]);
	const getPath=registryPathField(dlg,plugin.app,'manifest');
	dlg.action(tr('预览登记','Preview registration'),async()=>{
		const lib=await selectMobileManifest(plugin.ctx,getPath());
		const existing=await discoverMobile(plugin.ctx);
		const ignore=await previewMobileRegistryIgnore(plugin.ctx);
		const related=existing.filter(entry=>lib.identity && entry.identity?.id===lib.identity.id && entry.location!==lib.location);
		const lines=[...(replace?[replace+' → '+lib.location]:[]),...manifestLines(lib),...registryIgnoreLines(ignore),
			...related.map(entry=>tr('相同 ID · ','Same ID · ')+entry.location)];
		if(lib.identity && !related.length){
			const plan=await previewBindings(plugin.ctx,lib.location,lib.location,lib.manifest!,plugin.templates.kepano);
			if(plan.edits.length || plan.manual.length)lines.push(...bindingLines(plan),tr('可在登记后单独确认绑定修改','Review and confirm binding changes after registration'));
		}
		confirm(plugin,tr('确认登记','Confirm registration'),lines,async()=>{
			await plugin.catalogWrite(()=>registerMobile(plugin.ctx,[lib],replace,ignore));
		},()=>dlg.close());
	});
	dlg.open();
}

export function scanForm(plugin:MobilePlugin){
	const dlg=new Dialog(plugin.app,tr('扫描目录并登记知识库','Scan a folder and register knowledge bases'));
	const getFolder=registryPathField(dlg,plugin.app,'folder');
	async function scan(folder:string){
		const libraries=await scanMobile(plugin.ctx,folder),found=libraries.filter(lib=>!lib.problem);
		const review=new Dialog(plugin.app,tr('扫描结果','Scan results'));
		const current=await discoverMobile(plugin.ctx);
		const ignore=await previewMobileRegistryIgnore(plugin.ctx);
		const ignoreLines=registryIgnoreLines(ignore);
		if(ignoreLines.length)review.lines(ignoreLines);
		const selected=new Set<string>();
		const known=new Map([...current,...found].map(entry=>[entry.location,entry]));
		for(const lib of found){
			const duplicate=[...known.values()].filter(entry=>lib.identity && entry.identity?.id===lib.identity.id && entry.location!==lib.location);
			const registered=current.some(entry=>entry.location===lib.location),details=manifestLines(lib).slice(1);
			if(registered)details.push(tr('已登记','Registered'));
			for(const entry of duplicate)details.push(tr('相同 ID · ','Same ID · ')+entry.location);
			const row=new Setting(review.contentEl).setName(lib.location).setDesc(details.join('\n'));
			if(registered)continue;
			if(!duplicate.length)selected.add(lib.location);
			row.addToggle(toggle=>
				toggle.setValue(selected.has(lib.location)).onChange(value=>{if(value)selected.add(lib.location);else selected.delete(lib.location);}));
		}
		review.lines(libraries.filter(lib=>lib.problem).map(lib=>lib.location+' · '+lib.problem));
		if(!libraries.length)review.lines([tr('未找到知识库清单','No library manifests found')]);
		if(found.some(lib=>!current.some(entry=>entry.location===lib.location)))review.action(tr('登记所选路径','Register selected paths'),async()=>{
			if(!selected.size)throw new Error(tr('请选择至少一条路径','Select at least one path'));
			await plugin.catalogWrite(()=>registerMobile(plugin.ctx,found.filter(lib=>selected.has(lib.location)),undefined,ignore));
			review.close();dlg.close();await plugin.refresh();
		});
		review.open();
	}
	dlg.action(tr('扫描所选目录','Scan selected folder'),async()=>{
		const folder=getFolder();
		if(!folder)throw new Error(tr('请选择目录','Select a folder'));
		await scan(folder);
	});
	dlg.action(tr('扫描整个 Vault','Scan entire vault'),()=>scan(''));
	dlg.open();
}

export function removeRegistration(plugin:MobilePlugin,library:Library){
	confirm(plugin,tr('移除登记路径','Remove registered path'),[library.location],async()=>{
		await plugin.catalogWrite(async()=>{
			const fresh=(await discoverMobile(plugin.ctx)).find(entry=>entry.location===library.location);
			if(!fresh?.missing)throw new Error(tr('登记状态已变化，请刷新','Registration state has changed. Refresh the manager.'));
			await updateMobileRegistry(plugin.ctx,{remove:[library.location]});
		});
	});
}

export async function resolveDuplicate(plugin:MobilePlugin,lib:Library){
	const id=lib.identity?.id,entries=(await discoverMobile(plugin.ctx)).filter(entry=>entry.identity?.id===id);
	if(!id || entries.length<2)throw new Error(tr('已无重复 ID，请刷新','The ID is no longer duplicated. Refresh the manager.'));
	const dlg=new Dialog(plugin.app,tr('处理重复 ID','Resolve duplicate ID'));
	dlg.lines(entries.map(entry=>entry.location+' · '+id));
	const choices=entries.filter(entry=>entry.location!==lib.location);
	let original=choices[0]?.location;
	dlg.choice(tr('保留原 ID 的知识库','Library that keeps the original ID'),Object.fromEntries(choices.map(entry=>[entry.location,entry.location])),v=>{original=v;});
	dlg.action(tr('预览副本的新 ID','Preview the copy’s new ID'),()=>{
		const chosen=original,newId=crypto.randomUUID();
		confirm(plugin,tr('为副本生成新 ID','Assign a new ID to the copy'),[tr('保留原 ID · ','Keep original ID · ')+chosen,
			lib.location+'/'+identityFile+' · '+id+' → '+newId],async()=>{
			await plugin.catalogWrite(()=>assignMobileCopyId(plugin.ctx,lib,chosen!,newId));
		},()=>dlg.close());
		return Promise.resolve();
	});
	dlg.open();
}

export async function adoptLegacy(plugin:MobilePlugin,lib:Library){
	const {ctx}=plugin;
	const path=lib.location+'/'+identityFile,raw=await ctx.disk.read(path),manifest=readManifest(raw);
	if(!lib.legacy || manifest.identity || !manifest.mapping)throw new Error(tr('请选择只有目录映射的清单','Select a manifest that contains a path mapping'));
	const identity=newIdentity(lib.location.split('/').pop()!,'',undefined,manifest.mapping.index);
	const ignorePath=lib.location+'/.gitignore';
	const ignore=(await ctx.disk.stat(ignorePath))?await ctx.disk.read(ignorePath):undefined;
	const nextIgnore=withManifestIgnore(ignore??'');
	confirm(plugin,tr('按新库接管','Adopt as a new library'),[path,identity.displayName+' · '+identity.id,...(nextIgnore!==ignore?[ignorePath+' · /'+identityFile]:[])],async()=>{
		await plugin.catalogWrite(async()=>{
			const fresh=(await discoverMobile(ctx)).find(entry=>entry.location===lib.location);
			if(fresh?.manifest!==raw)throw new Error(tr('清单已变化，请重新预览','Manifest changed. Review it again.'));
			await replaceText(ctx.disk,ignorePath,ignore,nextIgnore);
			await replaceText(ctx.disk,path,raw,writeIdentity(raw,identity));
		});
	});
}

export async function bindingForm(plugin:MobilePlugin,lib:Library){
	const {ctx,templates}=plugin,saved=plugin.bindingRecovery(lib.location);
	const plan=saved??await previewBindings(ctx,lib.location,lib.location,await ctx.disk.read(lib.location+'/'+identityFile),templates.kepano);
	const title=saved?tr('恢复绑定更新','Resume binding changes'):tr('预览路径绑定','Preview path bindings');
	if(!plan.edits.length){
		const dlg=new Dialog(plugin.app,title);dlg.lines([lib.location,...bindingLines(plan)]);dlg.open();return;
	}
	confirm(plugin,title,[lib.location,...bindingLines(plan)],async()=>{
		await plugin.catalogWrite(async()=>{
			if(saved){await resumeLibraryBindings(ctx,plan,templates.kepano);plugin.saveBindingRecovery(lib.location);}
			else await applyLibraryBindings(ctx,lib,plan,templates.kepano,pending=>plugin.saveBindingRecovery(lib.location,pending));
		});
	});
}
