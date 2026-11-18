import { TFile } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { digest } from '../fs/vault.ts';
import { discover, recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { applyRepair,checkIndexLinks,examine } from '../kb/maintenance.ts';
import type { VisibleFiles } from '../kb/maintenance.ts';
import { executeMove,planMove } from '../kb/move.ts';
import type { MoveRecord } from '../kb/move.ts';
import { changeIdentity } from './identity.ts';
import { inspectSources } from '../kb/sources.ts';
import { Dialog } from './dialog.ts';

function visible(plugin:KnowledgeBaseManager):VisibleFiles {
	const vault=plugin.app.vault;
	return {
		create:async(relative,content)=>{await plugin.disk.path(relative);await vault.create(relative,content);},
		replace:async(relative,before,after)=>{
			await plugin.disk.path(relative);
			const file=vault.getAbstractFileByPath(relative);
			if(!(file instanceof TFile))throw new Error('等待 Obsidian 刷新路径后，请在管理器中继续');
			await vault.process(file,text=>{
				if(digest(text)!==before)throw new Error('文件已变化，请重新预览：'+relative);
				return after;
			});
		}
	};
}

export function edit(plugin:KnowledgeBaseManager,lib:Library){
	if(!lib.identity)return;
	const previous=lib.identity;
	let name=previous.displayName,description=previous.description;
	const dialog=new Dialog(plugin.app,'编辑知识库');
	dialog.lines([lib.location+'/kb-manager.json']);
	dialog.text('显示名',name,v=>{name=v;});dialog.text('简介',description,v=>{description=v;});
	const confirm=(archive:boolean)=>{
		const next=new Dialog(plugin.app,'确认清单修改');
		next.lines([lib.location+'/kb-manager.json',previous.displayName+' → '+name,previous.description+' → '+description,
			'归档：'+String(previous.archived)+' → '+String(archive)]);
		next.action('应用',async()=>{
			if(!name.trim())throw new Error('请输入显示名');
			await plugin.exclusive(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await changeIdentity(plugin,lib,value=>{value.displayName=name;value.description=description;value.archived=archive;});
			});
			next.close();dialog.close();await plugin.refresh();
		});next.open();
	};
	dialog.action('预览元信息',()=>{confirm(previous.archived);return Promise.resolve();});
	dialog.action(previous.archived?'恢复活动状态':'归档',()=>{confirm(!previous.archived);return Promise.resolve();});
	dialog.open();
}

export async function health(plugin:KnowledgeBaseManager,lib:Library){
	const dialog=new Dialog(plugin.app,'知识库体检');
	const report=await examine(plugin.disk,lib,plugin.skeleton);
	const links=[...await checkIndexLinks(plugin.disk,lib),...await inspectSources(plugin.disk,lib)];
	dialog.lines([lib.location, ...report.manual,...links,...report.repairs.flatMap(r=>[r.file,...r.fields])]);
	if(!report.manual.length && !links.length && !report.repairs.length)dialog.lines(['结构检查未发现问题']);
	for(const item of report.repairs){
		if(lib.identity?.archived || lib.duplicate || lib.problem)continue;
		dialog.action('应用此修复：'+item.file,async()=>{
			await plugin.exclusive(lib.location,()=>applyRepair(plugin.disk,plugin.config,lib,item,visible(plugin)));
			dialog.close();
			const current=(await discover(plugin.disk,plugin.config)).find(l=>l.location===lib.location);
			if(current)await health(plugin,current);
		});
	}
	dialog.open();
}

export async function resumeMove(plugin:KnowledgeBaseManager,record:MoveRecord){
	await plugin.exclusive(record.source,()=>executeMove(plugin.disk,plugin.config,record,visible(plugin),v=>plugin.recordMove(v)),true);
	await plugin.refresh();
}

export function move(plugin:KnowledgeBaseManager,lib:Library){
	const old=lib.location.split('/'), original=old.pop()!;
	let parent=old.join('/'), name=original, additional='';
	const dialog=new Dialog(plugin.app,'移动或重命名知识库');
	const choices=[parent,...plugin.config.parents.filter(p=>p!==parent)];
	dialog.choice('目标父目录',Object.fromEntries(choices.map(p=>[p,p])),v=>{parent=v;});
	dialog.text('或登记已存在的新父目录','',v=>{additional=v.trim();});
	dialog.text('目标目录名',name,v=>{name=v;});
	dialog.action('预览',async()=>{
		const target=additional || parent;
		const proposedConfig=()=>({...plugin.config,parents:[...new Set([...plugin.config.parents,target])]});
		const plan=await planMove(plugin.disk,proposedConfig(),lib,target,name,plugin.skeleton);
		const links=new Set<string>();
		for(const [from,targets] of Object.entries(plugin.app.metadataCache.resolvedLinks)){
			for(const to of Object.keys(targets))if(to.startsWith(lib.location+'/'))links.add(from+' → '+to);
		}
		const confirm=new Dialog(plugin.app,'确认目录移动');
		confirm.lines([...(plugin.config.parents.includes(target)?[]:['登记已有父目录：'+target]),plan.source+' → '+plan.destination,...plan.changes.flatMap(c=>[c.file,...c.fields]),...plan.warnings,
			'以下已解析的链接可能失效。外部剪藏、脚本与动态查询需人工核对。',...links]);
		confirm.action('移动完整目录',async()=>{
			const fresh=await planMove(plugin.disk,proposedConfig(),lib,target,name,plugin.skeleton);
			if(JSON.stringify({...fresh,token:plan.token})!==JSON.stringify(plan))throw new Error('预览已变化');
			plugin.config=proposedConfig();
			await plugin.recordMove(plan);
			confirm.close();dialog.close();
			try{await resumeMove(plugin,plan);}finally{await plugin.refresh();}
		});confirm.open();
	});dialog.open();
}
