import {Setting} from 'obsidian';
import {tr} from '../i18n.ts';
import {identityFile,readManifest,withManifestIgnore,writeIdentity} from '../kb/identity-core.ts';
import {Dialog} from '../ui/dialog.ts';
import {changeActions,changeComparison} from '../ui/change-preview.ts';
import {registryPathField} from '../ui/registry-path-field.ts';
import {registryIgnoreFor,withIgnoreRule} from '../registry/paths.ts';
import {applyLibraryBindings,bindingLines,previewBindings,resumeLibraryBindings} from './bindings.ts';
import {newIdentity} from './catalog.ts';
import {checkSpelling,replaceText} from './disk.ts';
import type MobilePlugin from './plugin.ts';
import {assignMobileCopyId,discoverMobile,previewMobileRegistryIgnore,previewMobileRemoval,registerMobile,scanMobile,selectMobileManifest} from './registration.ts';
import type {Library} from './registration.ts';

function manifestLines(lib:Library){
	const identity=lib.identity,entry=identity?.entry??lib.mapping?.index;
	return [lib.location+'/'+identityFile,identity?identity.displayName+' · '+identity.id:tr('仅有目录映射，可按新库接管','Contains path mapping. Available for adoption.'),
		...[tr('首页 · ','Homepage · ')+(entry?lib.location+'/'+entry:tr('未设置','None'))],
		...Object.entries(lib.preferences??{}).map(([key,value])=>'preferences.'+key+' = '+String(value))];
}

function showIgnoreChange(dialog:Dialog,path:string,before:string|undefined,rule:string){
	changeComparison(dialog.contentEl,[{label:path,before:before===undefined?tr('文件缺失','File missing'):
		tr('尚无此规则','Rule absent'),after:rule,code:true}]);
}

function registrationActions(plugin:MobilePlugin,dialog:Dialog,label:string,apply:()=>Promise<void>,close?:()=>void){
	changeActions(dialog.contentEl,[{label,primary:true,run:async()=>{
		await apply();dialog.close();close?.();await plugin.refresh();
	}}]);
}

export async function registryIgnoreForm(plugin:MobilePlugin){
	const {disk,configDir}=plugin.ctx,path='.gitignore',rule=registryIgnoreFor(configDir);
	await checkSpelling(disk,path);
	const before=(await disk.stat(path))?await disk.read(path):undefined;
	const after=withIgnoreRule(before??null,rule);
	const dialog=new Dialog(plugin.app,tr('仓库的 Git 忽略规则','Vault Git ignore rule'));
	if(after===before)dialog.lines([path,rule,tr('规则已存在','Rule already present')]);
	else{
		showIgnoreChange(dialog,path,before,rule);
		registrationActions(plugin,dialog,tr('写入仓库的 Git 忽略规则','Write the Vault Git ignore rule'),
			()=>plugin.catalogWrite(()=>replaceText(disk,path,before,after)));
	}
	dialog.open();
}

export function manifestForm(plugin:MobilePlugin,replace?:string){
	const dlg=new Dialog(plugin.app,replace?tr('重新定位知识库','Locate a library'):tr('登记知识库清单','Register a library manifest'));
	if(replace)dlg.lines([replace]);
	const getPath=registryPathField(dlg,plugin.app,'manifest');
	dlg.action(tr('预览登记','Preview registration'),async origin=>{
		const lib=await selectMobileManifest(plugin.ctx,getPath());
		const existing=await discoverMobile(plugin.ctx);
		const ignore=await previewMobileRegistryIgnore(plugin.ctx);
		const related=existing.filter(entry=>lib.identity && entry.identity?.id===lib.identity.id && entry.location!==lib.location);
		const review=new Dialog(plugin.app,replace?tr('确认重新定位','Confirm relocation'):tr('确认登记','Confirm registration'),dlg.owner)
			.returnFocusTo(origin);
		if(replace)changeComparison(review.contentEl,[{label:tr('登记路径','Registered path'),before:replace,after:lib.location}]);
		const lines=[...manifestLines(lib),
			...related.map(entry=>tr('相同 ID · ','Same ID · ')+entry.location)];
		if(lib.identity)lines.push(tr('路径不同时，请在登记后核对普通链接和 Base 路径。','If the library path changed, check ordinary links and Base paths after registration.'));
		if(lib.identity && !related.length){
			const plan=await previewBindings(plugin.ctx,lib.location,lib.location,lib.manifest!,plugin.templates.kepano);
			if(plan.edits.length || plan.manual.length)lines.push(...bindingLines(plan),tr('可在登记后单独确认绑定修改','Review and confirm binding changes after registration'));
		}
		review.lines(lines);
		if(ignore && ignore.before!==ignore.after)showIgnoreChange(review,ignore.path,ignore.before,ignore.rule);
		registrationActions(plugin,review,replace?tr('更新登记路径','Update registered path'):tr('登记知识库','Register library'),async()=>{
			await plugin.catalogWrite(()=>registerMobile(plugin.ctx,[lib],replace,ignore));
		},()=>dlg.close());
		review.open();
	});
	dlg.open();
}

export function scanForm(plugin:MobilePlugin){
	const dlg=new Dialog(plugin.app,tr('扫描目录并登记知识库','Scan a folder and register knowledge bases'));
	const getFolder=registryPathField(dlg,plugin.app,'folder',{favorites:plugin.ctx.parents});
	async function scan(folder:string,origin:HTMLButtonElement){
		const libraries=await scanMobile(plugin.ctx,folder),found=libraries.filter(lib=>!lib.problem);
		const review=new Dialog(plugin.app,tr('扫描结果','Scan results'),dlg.owner).returnFocusTo(origin);
		const current=await discoverMobile(plugin.ctx);
		const ignore=await previewMobileRegistryIgnore(plugin.ctx);
		if(ignore && ignore.before!==ignore.after)showIgnoreChange(review,ignore.path,ignore.before,ignore.rule);
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
		if(found.some(lib=>!current.some(entry=>entry.location===lib.location)))registrationActions(
			plugin,review,tr('登记所选路径','Register selected paths'),async()=>{
			if(!selected.size)throw new Error(tr('请选择至少一条路径','Select at least one path'));
			await plugin.catalogWrite(()=>registerMobile(plugin.ctx,found.filter(lib=>selected.has(lib.location)),undefined,ignore));
		},()=>dlg.close());
		review.open();
	}
	dlg.action(tr('扫描所选目录','Scan selected folder'),origin=>scan(getFolder(),origin));
	dlg.open();
}

export async function removeRegistration(plugin:MobilePlugin,library:Library){
	const {location}=library;
	const apply=await previewMobileRemoval(plugin.ctx,library);
	const review=new Dialog(plugin.app,tr('移除登记','Remove registration'));
	changeComparison(review.contentEl,[{label:tr('登记路径','Registered path'),before:location,after:tr('移除登记','Removed from registry')}]);
	review.lines([tr('此操作从列表移除此知识库，保留目录和文件。','This removes the library from the list and preserves the folder and files.')]);
	registrationActions(plugin,review,tr('移除登记','Remove registration'),async()=>{
		await plugin.catalogWrite(async()=>{
			if(plugin.bindingRecovery(location))throw new Error(tr('请先恢复绑定更新','Resume the pending binding changes first'));
			await apply();
		});
	});
	review.open();
}

export async function resolveDuplicate(plugin:MobilePlugin,lib:Library){
	const id=lib.identity?.id,entries=(await discoverMobile(plugin.ctx)).filter(entry=>entry.identity?.id===id);
	if(!id || entries.length<2)throw new Error(tr('已无重复 ID，请刷新','The ID is no longer duplicated. Refresh the manager.'));
	const dlg=new Dialog(plugin.app,tr('处理重复 ID','Resolve duplicate ID'));
	dlg.lines(entries.map(entry=>entry.location+' · '+id));
	const choices=entries.filter(entry=>entry.location!==lib.location);
	let original=choices[0]?.location;
	dlg.choice(tr('保留原 ID 的知识库','Library that keeps the original ID'),Object.fromEntries(choices.map(entry=>[entry.location,entry.location])),v=>{original=v;});
	dlg.action(tr('预览副本的新 ID','Preview the copy’s new ID'),origin=>{
		const chosen=original,newId=crypto.randomUUID();
		const review=new Dialog(plugin.app,tr('为副本生成新 ID','Assign a new ID to the copy'),dlg.owner).returnFocusTo(origin);
		review.facts([[tr('保留原 ID 的知识库','Library that keeps the original ID'),chosen??''],
			[tr('副本清单','Copy manifest'),lib.location+'/'+identityFile]]);
		changeComparison(review.contentEl,[{label:tr('副本的知识库 ID','Copy library ID'),before:id,after:newId}]);
		registrationActions(plugin,review,tr('为副本生成新 ID','Assign a new ID to the copy'),async()=>{
			await plugin.catalogWrite(()=>assignMobileCopyId(plugin.ctx,lib,chosen!,newId));
		},()=>dlg.close());
		review.open();
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
	const review=new Dialog(plugin.app,tr('按新库接管','Adopt as a new library'));
	review.facts([[tr('清单','Manifest'),path],[tr('显示名','Display name'),identity.displayName]]);
	changeComparison(review.contentEl,[{label:tr('知识库 ID','Library ID'),before:tr('未分配','Unassigned'),after:identity.id}]);
	if(nextIgnore!==ignore)showIgnoreChange(review,ignorePath,ignore,'/'+identityFile);
	registrationActions(plugin,review,tr('按新库接管','Adopt as a new library'),async()=>{
		await plugin.catalogWrite(async()=>{
			const fresh=(await discoverMobile(ctx)).find(entry=>entry.location===lib.location);
			if(fresh?.manifest!==raw)throw new Error(tr('清单已变化，请重新预览','Manifest changed. Review it again.'));
			await replaceText(ctx.disk,ignorePath,ignore,nextIgnore);
			await replaceText(ctx.disk,path,raw,writeIdentity(raw,identity));
		});
	});
	review.open();
}

export async function bindingForm(plugin:MobilePlugin,lib:Library){
	const {ctx,templates}=plugin,saved=plugin.bindingRecovery(lib.location);
	const plan=saved??await previewBindings(ctx,lib.location,lib.location,await ctx.disk.read(lib.location+'/'+identityFile),templates.kepano);
	const title=saved?tr('恢复绑定更新','Resume binding changes'):tr('预览路径绑定','Preview path bindings');
	if(!plan.edits.length){
		const dlg=new Dialog(plugin.app,title);dlg.lines([lib.location,...bindingLines(plan)]);dlg.open();return;
	}
	const review=new Dialog(plugin.app,title);
	review.facts([[tr('知识库','Library'),lib.location]]);
	for(const file of plan.edits){
		const details=review.contentEl.createEl('details',{cls:'kb-v3-detail'});
		details.createEl('summary',{text:file.path});
		changeComparison(details,[{label:tr('绑定目录','Bound folder'),before:file.from,after:plan.location},
			{label:tr('文件内容','File content'),before:file.before,after:file.after,code:true}]);
	}
	if(plan.manual.length)review.lines(plan.manual);
	registrationActions(plugin,review,saved?tr('继续更新路径绑定','Resume path binding update'):tr('更新路径绑定','Update path bindings'),async()=>{
		await plugin.catalogWrite(async()=>{
			if(saved){await resumeLibraryBindings(ctx,plan,templates.kepano);plugin.saveBindingRecovery(lib.location);}
			else await applyLibraryBindings(ctx,lib,plan,templates.kepano,pending=>plugin.saveBindingRecovery(lib.location,pending));
		});
	});
	review.open();
}
