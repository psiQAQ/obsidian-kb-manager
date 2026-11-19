import { tr } from '../i18n.ts';
import { Notice, Setting, TFile } from 'obsidian';
import type { ButtonComponent, ToggleComponent } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { digest } from '../fs/vault.ts';
import { discover, recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { applyRepair } from '../kb/maintenance.ts';
import type { Repair, VisibleFiles } from '../kb/maintenance.ts';
import { executeMove,planMove } from '../kb/move.ts';
import type { MoveRecord } from '../kb/move.ts';
import { changeIdentity } from './identity.ts';
import { createAuditSession } from '../kb/audit.ts';
import { auditChecks } from '../kb/audit-types.ts';
import type { AuditCheck, AuditResult } from '../kb/audit-types.ts';
import { Dialog } from './dialog.ts';

export function visible(plugin:KnowledgeBaseManager):VisibleFiles {
	const vault=plugin.app.vault;
	return {
		create:async(relative,content)=>{await plugin.disk.path(relative);await vault.create(relative,content);},
		replace:async(relative,before,after)=>{
			await plugin.disk.path(relative);
			const file=vault.getAbstractFileByPath(relative);
			if(!(file instanceof TFile))throw new Error(tr('等待 Obsidian 刷新路径后，请在管理器中继续',"Wait for Obsidian to refresh the path, then continue in the manager"));
			await vault.process(file,text=>{
				if(digest(text)!==before)throw new Error(tr('文件已变化，请重新预览：',"File changed. Preview again: ")+relative);
				return after;
			});
		}
	};
}

export function edit(plugin:KnowledgeBaseManager,lib:Library){
	if(!lib.identity)return;
	const previous=lib.identity;
	let name=previous.displayName,description=previous.description;
	const dialog=new Dialog(plugin.app,tr('编辑知识库',"Edit knowledge base"));
	dialog.lines([lib.location+'/kb.toml']);
	dialog.text(tr('显示名',"Display name"),name,v=>{name=v;});dialog.multiline(tr('简介',"Description"),description,v=>{description=v;});
	const confirm=(archive:boolean)=>{
		const next=new Dialog(plugin.app,tr('确认清单修改',"Confirm manifest changes"));
		next.lines([lib.location+'/kb.toml',previous.displayName+' → '+name,previous.description+' → '+description,
			tr('归档：',"Archived: ")+String(previous.archived)+' → '+String(archive)]);
		next.action(tr('应用',"Apply"),async()=>{
			if(!name.trim())throw new Error(tr('请输入显示名',"Enter a display name"));
			await plugin.exclusive(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await changeIdentity(plugin,lib,value=>{value.displayName=name;value.description=description;value.archived=archive;});
			});
			next.close();dialog.close();await plugin.refresh();
		});next.open();
	};
	dialog.action(tr('预览元信息',"Preview metadata"),()=>{confirm(previous.archived);return Promise.resolve();});
	dialog.action(previous.archived?tr('恢复活动状态',"Restore to active"):tr('归档',"Archive"),()=>{confirm(!previous.archived);return Promise.resolve();});
	dialog.open();
}

const auditLabels:Record<AuditCheck,()=>string>={
	identity:()=>tr('身份与目录','Identity and folders'),
	properties:()=>tr('属性','Properties'),
	links:()=>tr('链接与嵌入','Links and embeds'),
	index:()=>tr('索引覆盖','Index coverage'),
	ingestion:()=>tr('来源与摄入','Sources and ingestion'),
	bindings:()=>tr('Base 与受管绑定','Bases and managed bindings'),
};
const auditPurpose:Record<AuditCheck,()=>string>={
	identity:()=>tr('核对库身份、入口和映射位置','Check library identity, its entry and mapped paths'),
	properties:()=>tr('检查 YAML 及知识页或操作记录的属性','Check YAML, knowledge page and operation properties'),
	links:()=>tr('检查本库链接、嵌入、标题和块引用','Check library links, embeds, headings and block references'),
	index:()=>tr('按目录映射核对知识页是否收录','Use the path mapping to check index coverage'),
	ingestion:()=>tr('核对来源引用、原文和摄入记录','Check source references, raw material and ingestion records'),
	bindings:()=>tr('检查 Base 配置及清单声明的受管文件','Check Base configuration and manifest-managed files'),
};

export function health(plugin:KnowledgeBaseManager,lib:Library){
	const dialog=new Dialog(plugin.app,tr('知识库体检',"Check library"));
	dialog.contentEl.createEl('p',{text:lib.location});
	const selected=new Set<AuditCheck>();
	const toggles=new Map<AuditCheck,ToggleComponent>();
	const runButtons:ButtonComponent[]=[];
	const results=new Map<AuditCheck,AuditResult>();
	let current=lib,running=false;
	const selectAll=new Setting(dialog.contentEl).setName(tr('全选','Select all'));
	let allToggle:ToggleComponent;
	selectAll.addToggle(toggle=>{
		allToggle=toggle;
		toggle.toggleEl.setAttribute('aria-label',tr('全选','Select all'));
		toggle.onChange(value=>{
			selected.clear();
			if(value)for(const check of auditChecks)selected.add(check);
			for(const component of toggles.values())component.setValue(value);
			updateControls();
		});
	});
	const descriptions=new Map<AuditCheck,Setting>();
	function describe(check:AuditCheck,status:string){
		descriptions.get(check)?.setDesc(auditPurpose[check]()+' · '+status);
	}
	for(const check of auditChecks){
		const row=new Setting(dialog.contentEl).setName(auditLabels[check]());
		descriptions.set(check,row);
		describe(check,tr('尚未运行','Not run'));
		row.addToggle(toggle=>{
			toggles.set(check,toggle);
			toggle.toggleEl.setAttribute('aria-label',auditLabels[check]());
			toggle.onChange(value=>{
				if(value)selected.add(check);else selected.delete(check);
				updateControls();
			});
		});
		row.addButton(button=>{
			runButtons.push(button);
			button.setButtonText(tr('运行此项','Run this check')).onClick(()=>runChecks([check]));
		});
	}
	const actions=new Setting(dialog.contentEl);
	let selectedButton:ButtonComponent;
	actions.addButton(button=>{
		selectedButton=button;
		button.setButtonText(tr('运行所选检查','Run selected checks')).setCta().onClick(()=>runChecks([...selected]));
	}).addButton(button=>{
		runButtons.push(button);
		button.setButtonText(tr('运行全部适用项','Run all applicable checks')).onClick(()=>runChecks(auditChecks));
	});
	const output=dialog.contentEl.createDiv();
	function updateControls(){
		allToggle.setValue(selected.size===auditChecks.length).setDisabled(running);
		for(const toggle of toggles.values())toggle.setDisabled(running);
		for(const button of runButtons)button.setDisabled(running);
		selectedButton.setDisabled(running || !selected.size);
	}
	function renderResults(){
		output.empty();
		for(const check of auditChecks){
			const result=results.get(check);
			if(!result)continue;
			const {findings,repairs,reason,details}=result;
			const findingStatus=findings.some(f=>f.level==='error') ? tr('有错误','Errors found') : tr('需复核','Needs review');
			const status={clean:tr('通过','Passed'),findings:findingStatus,failed:tr('未能完成','Could not complete'),
				'not-applicable':tr('不适用','Not applicable')}[result.status];
			describe(check,status);
			if(!findings.length && !repairs.length && !reason && !details?.length)continue;
			const detail=output.createEl('details');
			detail.createEl('summary',{text:auditLabels[check]()+' · '+status});
			if(reason)detail.createEl('p',{text:reason});
			if(details)for(const line of details)detail.createEl('p',{text:line});
			if(findings.length){
				const list=detail.createEl('ul');
				for(const f of findings)list.createEl('li',{text:[f.level==='error'?tr('错误','Error'):tr('需复核','Review'),f.file,f.message].filter(Boolean).join(' · ')});
			}
			for(const item of repairs){
				const row=new Setting(detail).setName(item.file).setDesc(item.fields.join('\n'));
				row.addButton(b=>b.setButtonText(tr('预览修复','Preview repair')).onClick(()=>previewRepair(item)));
			}
		}
	}
	async function runChecks(checks:readonly AuditCheck[]){
		if(running)return;
		running=true;
		updateControls();
		for(const check of checks)describe(check,tr('进行中','Running'));
		try {
			if(!current.problem && !current.duplicate && !current.missing)current=await recheck(plugin.disk,plugin.config,current);
			const session=createAuditSession(plugin.disk,current,()=>plugin.templateAssets(current));
			for(const result of await session.run(checks))results.set(result.check,result);
		}catch(error){
			for(const check of checks)results.set(check,{check,status:'failed',findings:[],repairs:[],reason:String(error)});
			new Notice(String(error),8000);
		}finally{
			running=false;
			updateControls();
			renderResults();
		}
	}
	function previewRepair(item:Repair){
		const library=current;
		const preview=new Dialog(plugin.app,tr('预览受管文件修复','Preview managed file repair'));
		preview.lines([library.location+'/'+item.file,...item.fields]);
		preview.contentEl.createEl('pre').createEl('code',{text:item.after});
		if(!library.identity?.archived)preview.action(tr('应用此修复','Apply this repair'),async()=>{
			await plugin.exclusive(library.location,()=>applyRepair(plugin.disk,plugin.config,library,item,visible(plugin),plugin.templateAssets(library)));
			preview.close();
			const fresh=(await discover(plugin.disk,plugin.config)).find(l=>l.location===library.location);
			if(fresh){current=fresh;await runChecks(['bindings']);}
			await plugin.refresh();
		});
		preview.open();
	}
	updateControls();
	dialog.open();
}

export async function resumeMove(plugin:KnowledgeBaseManager,record:MoveRecord){
	await plugin.exclusive(record.source,()=>executeMove(plugin.disk,plugin.config,record,visible(plugin),v=>plugin.recordMove(v),plugin.kepanoSkeleton),true);
	await plugin.refresh();
}

export function move(plugin:KnowledgeBaseManager,lib:Library){
	const old=lib.location.split('/'), original=old.pop()!;
	const originalParent=old.join('/');
	let parent=plugin.config.parents.includes(originalParent)?originalParent:plugin.config.parents[0]??'', name=original, additional='';
	const dialog=new Dialog(plugin.app,tr('移动或重命名知识库',"Move or rename knowledge base"));
	const choices=[parent,...plugin.config.parents.filter(p=>p!==parent)].filter(Boolean);
	dialog.choice(tr('目标父目录',"Destination parent folder"),Object.fromEntries(choices.map(p=>[p,p])),v=>{parent=v;});
	dialog.text(tr('或登记已存在的新父目录',"Or register an existing parent folder"),'',v=>{additional=v.trim();},{example:'knowledge-base'});
	dialog.text(tr('目标目录名',"Destination folder name"),name,v=>{name=v;});
	dialog.action(tr('预览',"Preview"),async()=>{
		const target=additional || parent;
		const proposedConfig=()=>({...plugin.config,parents:[...new Set([...plugin.config.parents,target])]});
		const skeleton=plugin.templateAssets(lib);
		const plan=await planMove(plugin.disk,proposedConfig(),lib,target,name,skeleton);
		const links=new Set<string>();
		for(const [from,targets] of Object.entries(plugin.app.metadataCache.resolvedLinks)){
			for(const to of Object.keys(targets))if(to.startsWith(lib.location+'/'))links.add(from+' → '+to);
		}
		const confirm=new Dialog(plugin.app,tr('确认目录移动',"Confirm directory move"));
		confirm.lines([...(plugin.config.parents.includes(target)?[]:[tr('登记已有父目录：',"Register existing parent: ")+target]),plan.source+' → '+plan.destination,...plan.changes.flatMap(c=>[c.file,...c.fields]),...plan.warnings,
			tr('以下已解析的链接可能失效。外部剪藏、脚本与动态查询需人工核对。',"These links may break. Review external clippings, scripts and dynamic queries."),...links]);
		confirm.action(tr('移动完整目录',"Move entire directory"),async()=>{
			const fresh=await planMove(plugin.disk,proposedConfig(),lib,target,name,skeleton);
			if(JSON.stringify({...fresh,token:plan.token})!==JSON.stringify(plan))throw new Error(tr('预览已变化',"Preview has changed"));
			plugin.config=proposedConfig();
			await plugin.recordMove(plan);
			confirm.close();dialog.close();
			try{await resumeMove(plugin,plan);}finally{await plugin.refresh();}
		});confirm.open();
	});dialog.open();
}
