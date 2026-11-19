import {ItemView,Setting,WorkspaceLeaf} from 'obsidian';
import {tr} from '../i18n.ts';
import {Dialog} from '../ui/dialog.ts';
import {discoverMobile,verifyLibrary} from './catalog.ts';
import type {Library} from './catalog.ts';
import {commit,editIndex,effectiveAuthor,localAuthor,mobileHistory,mobileStatus} from './git.ts';
import {applyPull,pullPlan,secretKey,transfer,upstream} from './remote.ts';
import {mobileHttp} from './http.ts';
import {cloneForm,confirm,createForm,librarySettings,remoteSettings} from './forms.ts';
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
		const revision=++this.revision,p=this.plugin,el=this.contentEl;el.empty();
		const toolbar=new Setting(el);
		this.button(toolbar,tr('刷新','Refresh'),()=>this.draw());
		if(!p.paused()){
			this.button(toolbar,tr('创建','Create'),()=>createForm(p));
			this.button(toolbar,tr('克隆','Clone'),()=>cloneForm(p));
		}else el.createEl('p',{text:tr('此设备已暂停知识库 Git','Library Git is paused on this device')});
		try{
			const libs=await discoverMobile(p.ctx);
			if(this.revision!==revision)return;
			if(!libs.length)el.createEl('p',{text:tr('已登记的父目录中没有知识库','No knowledge bases found in the configured parent folders')});
			for(const lib of libs){
				const row=new Setting(el).setName(lib.identity?.displayName??lib.location).setDesc(lib.location);
				if(lib.problem || lib.duplicate || !lib.identity){
					row.setDesc(lib.location+' · '+(lib.problem??(lib.duplicate?tr('身份重复','Duplicate identity'):tr('旧库，可在桌面接管','Legacy library. Adopt on desktop.'))));continue;
				}
				if(p.paused())continue;
				const id=lib.identity.id;
				this.button(row,'Git',async()=>{this.selected=this.selected===id?undefined:id;await this.draw();});
				if(this.selected===id){
					const area=el.createDiv();
					try{await this.source(area,lib,revision);}catch(e){if(revision===this.revision)area.createEl('p',{text:String(e)});}
					if(revision!==this.revision)return;
				}
			}
		}catch(e){if(revision===this.revision)el.createEl('p',{text:String(e)});}
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
			const row=new Setting(el).setName((stage?tr('工作区更改','Changes'):tr('已暂存','Staged changes'))+' · '+group.length);
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
				if(write)this.button(file,action,()=>apply([c.file]));
			}
		}
		if(!write)return;
		const msg=new Setting(el).setName(tr('提交说明','Commit message')).addTextArea(c=>c.setValue(p.drafts.get(id)??'').onChange(v=>{p.drafts.set(id,v);}));
		this.button(msg,tr('提交','Commit'),async()=>{
			const text=p.drafts.get(id)?.trim(),files=state.changes.filter(c=>c.h!==c.i).map(c=>c.file);
			if(!text || !files.length)throw new Error(tr('请填写提交说明并暂存文件','Enter a message and stage files'));
			const author=effectiveAuthor(await localAuthor(s),p.deviceAuthor());
			confirm(p,tr('提交暂存的更改','Commit staged changes'),[lib.location,state.branch,author.name+' <'+author.email+'>',text,...files],async()=>{
				await p.exclusive(lib.location,async()=>{
					const device=p.deviceAuthor();
					if(JSON.stringify(effectiveAuthor(await localAuthor(s),device))!==JSON.stringify(author))throw new Error(tr('身份已变化，请重新预览','Identity changed. Review again.'));
					await commit(s,state,text,device);
				},lib);
				p.drafts.delete(id);
			});
		});
		const target=await upstream(s,state.branch);
		if(this.revision!==rev || !target)return;
		const network=new Setting(el).setName(target.remote+'/'+target.branch);
		for(const op of ['fetch','push'] as const){
			const label=op==='fetch'?tr('获取','Fetch'):tr('推送','Push');
			this.button(network,label,()=>confirm(p,label,[lib.location,state.branch,state.head,target.url,'refs/heads/'+target.branch],async()=>{
				await p.exclusive(lib.location,async()=>{
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
		dlg.lines([lib.location,...page.entries.map(e=>e.oid.slice(0,12)+' · '+e.commit.author.name+' · '+new Date(e.commit.author.timestamp*1000).toLocaleString()+' · '+e.commit.message)]);
		if(!page.entries.length)dlg.lines([tr('还没有提交','No commits yet')]);
		if(page.next)dlg.action(tr('更早的提交','Older commits'),async()=>{await this.history(lib,page.next);dlg.close();});
		dlg.open();
	}
}
