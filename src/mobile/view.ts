import {ItemView,Setting,WorkspaceLeaf} from 'obsidian';
import {tr} from '../i18n.ts';
import {Dialog} from '../ui/dialog.ts';
import {addTextField} from '../ui/text-field.ts';
import {discoverMobile,verifyLibrary} from './catalog.ts';
import type {Library} from './catalog.ts';
import {commit,editIndex,effectiveAuthor,localAuthor,mobileHistory,mobileStatus} from './git.ts';
import {applyPull,pullPlan,secretKey,transfer,upstream} from './remote.ts';
import {mobileHttp} from './http.ts';
import {cloneForm,confirm,createForm,librarySettings,remoteSettings} from './forms.ts';
import {adoptLegacy,bindingForm,manifestForm,removeRegistration,resolveDuplicate,scanForm} from './registration-forms.ts';
import type MobilePlugin from './plugin.ts';

export const viewType='knowledge-base-manager-view';
export class MobileView extends ItemView {
	private selected?:string;
	private revision=0;
	constructor(leaf:WorkspaceLeaf,private plugin:MobilePlugin){super(leaf);}
	getViewType(){return viewType;}
	getDisplayText(){return tr('知识库管理器','Knowledge base manager');}
	getIcon(){return 'library';}
	async onOpen(){await this.draw();}
	onClose(){this.revision++;return Promise.resolve();}
	private button(row:Setting,label:string,fn:()=>Promise<void>|void){
		row.addButton(c=>c.setButtonText(label).onClick(async()=>{
			c.setDisabled(true);
			try{await fn();}catch(e){this.plugin.report(e);}finally{c.setDisabled(false);}
		}));
	}
	async draw(){
		const revision=++this.revision,p=this.plugin,el=this.contentEl;el.empty();el.addClass('kb-manager-sidebar');
		const toolbar=new Setting(el);
		this.button(toolbar,tr('刷新','Refresh'),()=>this.draw());
		this.button(toolbar,tr('登记','Register'),()=>manifestForm(p));
		this.button(toolbar,tr('扫描','Scan'),()=>scanForm(p));
		if(!p.paused()){
			this.button(toolbar,tr('创建','Create'),()=>createForm(p));
			this.button(toolbar,tr('克隆','Clone'),()=>cloneForm(p));
		}else el.createEl('p',{text:tr('此设备已暂停知识库 Git','Library Git is paused on this device')});
		try{
			const libs=await discoverMobile(p.ctx);
			if(this.revision!==revision)return;
			if(!libs.length)el.createEl('p',{text:tr('还没有登记知识库','No registered knowledge bases')});
			for(const lib of libs){
				const row=new Setting(el).setName(lib.identity?.displayName??lib.location).setDesc(lib.location);
				if(lib.missing){
					row.setDesc(lib.location+' · '+tr('登记路径失联','Registered path missing'));
					this.button(row,tr('重新定位','Locate'),()=>manifestForm(p,lib.location));
					this.button(row,tr('移除登记','Remove registration'),()=>removeRegistration(p,lib));continue;
				}
				if(lib.problem){row.setDesc(lib.location+' · '+lib.problem);continue;}
				if(lib.duplicate){
					row.setDesc(lib.location+' · '+tr('身份重复','Duplicate identity')+' · '+lib.identity?.id);
					this.button(row,tr('处理重复 ID','Resolve duplicate ID'),()=>resolveDuplicate(p,lib));continue;
				}
				if(lib.legacy){this.button(row,tr('按新库接管','Adopt as a new library'),()=>adoptLegacy(p,lib));continue;}
				if(p.bindingRecovery(lib.location)){
					this.button(row,tr('恢复绑定更新','Resume binding changes'),()=>bindingForm(p,lib));continue;
				}
				if(lib.identity?.managed.some(item=>item.root && item.root!==lib.location)){
					this.button(row,tr('路径绑定','Path bindings'),()=>bindingForm(p,lib));
				}
				if(p.paused() || !lib.identity)continue;
				const id=lib.identity.id;
				this.button(row,'Git',async()=>{this.selected=this.selected===id?undefined:id;await this.draw();});
				if(this.selected===id){
					const area=el.createDiv({cls:'kb-library-git'});
					try{await this.source(area,lib,revision);}catch(e){if(revision===this.revision)area.createEl('p',{cls:'kb-git-error',text:String(e)});}
					if(revision!==this.revision)return;
				}
			}
		}catch(e){if(revision===this.revision)el.createEl('p',{cls:'kb-git-error',text:String(e)});}
	}
	private async source(el:HTMLElement,lib:Library,rev:number){
		const p=this.plugin,s=p.store(lib),id=lib.identity!.id;
		await verifyLibrary(p.ctx,lib);
		const state=await mobileStatus(s);
		if(this.revision!==rev)return;
		const top=new Setting(el).setName(state.branch).setDesc(state.head.slice(0,12));
		this.button(top,tr('历史','History'),()=>this.history(lib));
		const write=!lib.identity!.archived;
		if(write){
			this.button(top,tr('身份','Identity'),()=>librarySettings(p,lib));
			this.button(top,tr('远端','Remote'),()=>remoteSettings(p,lib));
		}
		for(const stage of [false,true]){
			const group=state.changes.filter(c=>stage?c.w!==c.i:c.h!==c.i);
			const row=new Setting(el).setHeading().setName((stage?tr('工作区更改','Working tree changes'):tr('已暂存','Staged changes'))+' ('+group.length+')');
			const action=stage?tr('暂存','Stage'):tr('取消暂存','Unstage');
			const apply=async(files:string[])=>{
				if(stage)effectiveAuthor(await localAuthor(s),p.deviceAuthor());
				const partial=files.filter(file=>group.some(c=>c.file===file && c.h!==c.i && c.w!==c.i));
				const warning=!partial.length?[]:[tr('含部分暂存文件。本操作将替换或移除这些文件的暂存版本。','This replaces or removes the staged version of these partially staged files.'),...partial];
				confirm(p,action,[lib.location,...files,...warning],async()=>{
					await p.exclusive(lib.location,async()=>{
						if(stage)effectiveAuthor(await localAuthor(s),p.deviceAuthor());
						await editIndex(s,state,files,stage);
					},lib);
				});
			};
			if(group.length && write)this.button(row,stage?tr('全部暂存','Stage all'):tr('全部取消暂存','Unstage all'),()=>apply(group.map(c=>c.file)));
			for(const c of group){
				const file=new Setting(el).setName(c.file);
				if(c.h!==c.i && c.w!==c.i)file.setDesc(tr('部分暂存','Partially staged'));
				if(write)this.button(file,action,()=>apply([c.file]));
			}
		}
		if(!write)return;
		const msg=addTextField(new Setting(el).setName(tr('提交说明','Commit message')),p.drafts.get(id)??'',v=>{p.drafts.set(id,v);},
			{example:tr('更新知识库笔记','Update knowledge base notes')},true);
		this.button(msg,tr('预览提交','Preview commit'),async()=>{
			const text=p.drafts.get(id)?.trim(),files=state.changes.filter(c=>c.h!==c.i).map(c=>c.file);
			if(!text || !files.length)throw new Error(tr('请填写提交说明并暂存文件','Enter a message and stage files'));
			const local=await localAuthor(s),author=effectiveAuthor(local,p.deviceAuthor()),signature=author.name+' <'+author.email+'>';
			const preview=new Dialog(p.app,tr('预览提交','Preview commit'));
			preview.facts([[tr('知识库路径','Library path'),lib.location],[tr('分支','Branch'),state.branch],[tr('提交说明','Commit message'),text]]);
			preview.contentEl.createEl('h3',{text:tr('提交身份','Commit identity')});
			const source=(value:string)=>value.trim()?tr('本库 Git 配置','Library Git config'):tr('本设备的 Vault 默认值','Vault default on this device');
			preview.facts([[tr('作者','Author'),signature],[tr('提交者','Committer'),signature],
				[tr('姓名来源','Name source'),source(local.name)],[tr('邮箱来源','Email source'),source(local.email)]]);
			const working=state.changes.filter(c=>c.i!==c.w),partial=new Set(working.filter(c=>c.h!==c.i).map(c=>c.file));
			const mark=(file:string)=>file+(partial.has(file)?' · '+tr('部分暂存','Partially staged'):'');
			preview.contentEl.createEl('h3',{text:tr('本次提交的暂存内容','Staged changes in this commit')+' ('+files.length+')'});
			preview.lines(files.map(mark));
			if(working.length){
				preview.contentEl.createEl('h3',{text:tr('留在工作区的更改','Changes kept in the working tree')+' ('+working.length+')'});
				preview.lines(working.map(c=>mark(c.file)));
			}
			preview.action(tr('提交已暂存内容','Commit staged changes'),async()=>{
				await p.exclusive(lib.location,async()=>{
					const device=p.deviceAuthor();
					if(JSON.stringify(effectiveAuthor(await localAuthor(s),device))!==JSON.stringify(author))throw new Error(tr('身份已变化，请重新预览','Identity changed. Review again.'));
					await commit(s,state,text,device);
				},lib);
				p.drafts.delete(id);
				preview.close();await p.refresh();
			});
			preview.open();
		});
		const target=await upstream(s,state.branch);
		if(this.revision!==rev || !target)return;
		const network=new Setting(el).setName(tr('同步目标','Sync target')).setDesc(target.remote+'/'+target.branch);
		for(const op of p.preferences(lib).disablePush?['fetch'] as const:['fetch','push'] as const){
			const label=op==='fetch'?tr('获取','Fetch'):tr('推送','Push');
			this.button(network,label,()=>confirm(p,label,[lib.location,state.branch,state.head,target.url,'refs/heads/'+target.branch],async()=>{
				await p.exclusive(lib.location,async()=>{
					if(op==='push'){
						const current=(await discoverMobile(p.ctx)).find(entry=>entry.location===lib.location);
						if(!current || p.preferences(current).disablePush)throw new Error(tr('此库已禁用推送','Push is disabled for this library'));
					}
					const stored=p.app.secretStorage.getSecret(await secretKey(id,target.url));
					const auth=stored?JSON.parse(stored) as {username:string;password:string}:undefined;
					await transfer(s,state,op,target,mobileHttp(target.url),auth);
				},lib);
			}));
		}
		this.button(network,tr('快进至已获取版本','Fast-forward to fetched version'),async()=>{
			const next=await pullPlan(s);
			confirm(p,tr('确认快进','Confirm fast-forward'),[lib.location,next.target.url,next.old.head+' → '+next.oid,...next.changes],async()=>{
				await p.exclusive(lib.location,()=>applyPull(s,next),lib);
			});
		});
	}
	private async history(lib:Library,cursor?:string){
		const p=this.plugin;p.assertEnabled();await verifyLibrary(p.ctx,lib);
		const page=await mobileHistory(p.store(lib),cursor);
		const dlg=new Dialog(p.app,tr('提交历史','Commit history'));
		dlg.facts([[tr('知识库路径','Library path'),lib.location]]);
		const list=dlg.contentEl.createDiv({cls:'kb-git-history'});
		for(const {oid,commit} of page.entries){
			const [subject,...body]=commit.message.trim().split('\n');
			const row=list.createEl('details');
			row.createEl('summary',{text:oid.slice(0,12)+' · '+(subject||tr('无提交说明','No commit message'))});
			row.createEl('p',{cls:'kb-commit-meta',text:commit.author.name+' · '+new Date(commit.author.timestamp*1000).toLocaleString()});
			const description=body.join('\n').trim();
			if(description)row.createEl('p',{cls:'kb-commit-body',text:description});
		}
		if(!page.entries.length)dlg.lines([tr('还没有提交','No commits yet')]);
		if(page.next)dlg.action(tr('更早的提交','Older commits'),async()=>{await this.history(lib,page.next);dlg.close();});
		dlg.open();
	}
}
