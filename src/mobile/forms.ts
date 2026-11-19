import {Setting} from 'obsidian';
import {tr} from '../i18n.ts';
import {readManifest} from '../kb/identity-core.ts';
import {Dialog} from '../ui/dialog.ts';
import {createPreview,instantiate} from './catalog.ts';
import type {Library} from './catalog.ts';
import {initialBranch,initialMessage} from './create-git.ts';
import {bindingLines} from './bindings.ts';
import {decode} from './disk.ts';
import {branchName,configure,localAuthor,mobileStatus} from './git.ts';
import {download,secretKey,upstream} from './remote.ts';
import type {CloneChoice} from './remote.ts';
import {endpoint,mobileHttp} from './http.ts';
import {registryIgnoreLines} from './registration.ts';
import type MobilePlugin from './plugin.ts';

export function confirm(plugin:MobilePlugin,title:string,lines:string[],apply:()=>Promise<void>,close?:()=>void) {
	const modal=new Dialog(plugin.app,title);
	modal.lines(lines);
	modal.action(tr('确认','Confirm'),async()=>{await apply();modal.close();close?.();await plugin.refresh();});
	modal.open();
}
function selector(dialog:Dialog,label:string,values:string[],change:(v:string)=>void) {
	dialog.choice(label,Object.fromEntries(values.map(v=>[v,v])),change);
}
export function createForm(plugin:MobilePlugin) {
	const {ctx}=plugin,dlg=new Dialog(plugin.app,tr('创建知识库','Create knowledge base'));
	const input={parent:ctx.parents[0]??'',name:'',displayName:'',description:'',source:'',author:plugin.deviceAuthor(),origin:''};
	selector(dlg,tr('父目录','Parent directory'),ctx.parents,v=>{input.parent=v;});
	dlg.text(tr('文件夹名称','Folder name'),'',v=>{input.name=v;});
	dlg.text(tr('显示名','Display name'),'',v=>{input.displayName=v;});
	dlg.text(tr('简介','Description'),'',v=>{input.description=v;});
	dlg.choice(tr('模板','Template'),{'':'LLM Wiki','builtin:kepano':'Kepano',...Object.fromEntries(ctx.templates.map(v=>[v,v]))},v=>{input.source=v;});
	dlg.text(tr('提交姓名','Commit author name'),input.author.name,v=>{input.author.name=v;});
	dlg.text(tr('提交邮箱','Commit author email'),input.author.email,v=>{input.author.email=v;});
	dlg.text(tr('origin HTTPS 地址（可选）','origin HTTPS URL (optional)'),'',v=>{input.origin=v;});
	dlg.action(tr('预览','Preview'),async()=>{
		plugin.assertEnabled();
		const p=await createPreview(ctx,{...input,displayName:input.displayName||input.name},plugin.templates);
		const review=new Dialog(plugin.app,tr('确认创建知识库','Confirm library creation'));
		const {author,origin,files}=p.initial,tracked=files.map(file=>file.name),trackedSet=new Set(tracked);
		review.lines([p.location,p.template.id,initialBranch+' · '+initialMessage,
			author.name+' <'+author.email+'>',
			tr('姓名和邮箱将写入本库 Git 配置和提交历史。','The name and email will be saved in this library’s Git config and commit history.'),
			...(origin?['origin · '+origin,tr('创建时只保存远端地址。','Creation only saves the remote URL.')]:[]),...registryIgnoreLines(p.registryIgnore)]);
		review.contentEl.createEl('h3',{text:tr('初始提交文件','Files in the initial commit')});
		review.lines(tracked);
		review.contentEl.createEl('h3',{text:tr('仅保存在本库的文件','Files kept in the library working tree')});
		review.lines([...new Set(['kb.toml',...p.template.files.map(file=>file.name)])].filter(file=>!trackedSet.has(file)));
		review.action(tr('创建并提交','Create and commit'),async()=>{
			plugin.assertEnabled();
			const result=await plugin.catalogWrite(()=>instantiate(plugin.ctx,p,plugin.templates));
			review.close();dlg.close();
			const receipt=new Dialog(plugin.app,tr('知识库已创建','Knowledge base created'));
			receipt.lines([result.location,result.branch+' · '+initialMessage,result.head,
				result.author.name+' <'+result.author.email+'>',...(result.origin?['origin · '+result.origin]:[]),
				tr('初始提交已验证，工作区干净，知识库已登记。','Verified the initial commit, clean working tree and library registration.')]);
			receipt.action(tr('关闭','Close'),()=>{receipt.close();return Promise.resolve();});
			receipt.open();await plugin.refresh();
		});
		review.open();
	});
	dlg.open();
}
function tokenField(dialog:Dialog,change:(value:string)=>void) {
	new Setting(dialog.contentEl).setName(tr('访问令牌（可选）','Access token (optional)')).addText(c=>{
		c.inputEl.type='password';c.inputEl.autocomplete='off';c.onChange(change);
	});
}
export function cloneForm(plugin:MobilePlugin) {
	const {ctx}=plugin,dlg=new Dialog(plugin.app,tr('克隆知识库','Clone knowledge base'));
	let parent=ctx.parents[0]??'',name='',url='',user='',token='';
	selector(dlg,tr('父目录','Parent directory'),ctx.parents,v=>{parent=v;});
	dlg.text(tr('目标目录名','Destination folder name'),'',v=>{name=v;});
	dlg.text(tr('远端 HTTPS 地址','Remote HTTPS URL'),'',v=>{url=v;});
	dlg.text(tr('认证用户名（可选）','Authentication username (optional)'),'',v=>{user=v;});
	tokenField(dlg,v=>{token=v;});
	dlg.action(tr('下载并预览','Download and preview'),async()=>{
		const address=endpoint(url),dest=parent+'/'+name;
		const result=await plugin.exclusive(dest,()=>download(ctx,parent,name,address,mobileHttp(address),token?{username:user||'git',password:token}:undefined));
		dlg.close();
		let publishing=false,closed=false;
		class CloneReview extends Dialog {
			onClose(){super.onClose();closed=true;if(!publishing)void result.cleanup().catch(e=>plugin.report(e));}
		}
		const review=new CloneReview(plugin.app,tr('选择克隆清单','Choose the clone manifest'));
		review.lines([result.location,address,result.branch,result.head,...result.files]);
		if(result.tracked)review.lines([tr('远端跟踪 kb.toml。请另外检查 Git 索引和历史。','The remote tracks kb.toml. Review the Git index and history separately.')]);
		async function preview(choice:CloneChoice){
			const approved=await result.review(plugin.ctx,choice,plugin.templates.kepano),manifest=readManifest(approved.source);
			confirm(plugin,tr('确认克隆','Confirm clone'),[result.location,address,result.branch,result.head,
				manifest.identity!.displayName+' · '+manifest.identity!.id,...(manifest.identity!.entry?[manifest.identity!.entry]:[]),
				...Object.entries(manifest.preferences).map(([key,value])=>'preferences.'+key+' = '+String(value)),
				...bindingLines(approved.bindings),...registryIgnoreLines(approved.registryIgnore)],async()=>{
				publishing=true;
				try{plugin.assertEnabled();await plugin.catalogWrite(()=>result.publish(plugin.ctx,approved,plugin.templates.kepano));review.close();}
				finally{publishing=false;if(closed)await result.cleanup();}
			});
		}
		if(result.hasManifest)review.action(tr('预览远端自带清单','Preview the remote manifest'),()=>preview({mode:'embedded'}));
		else{
			const picker=review.contentEl.createEl('input',{attr:{type:'file',accept:'.toml','aria-label':tr('原知识库的 kb.toml','Original library kb.toml')}});
			review.action(tr('预览原知识库清单','Preview the original manifest'),async()=>{
				const file=picker.files?.[0];
				if(!file || file.name!=='kb.toml')throw new Error(tr('请选择原知识库的 kb.toml','Select kb.toml from the original library'));
				await preview({mode:'original',raw:decode(new Uint8Array(await file.arrayBuffer()))});
			});
			review.action(tr('预览按新库接管','Preview adoption as a new library'),()=>preview({mode:'new'}));
		}
		review.open();
	});
	dlg.open();
}
export async function librarySettings(plugin:MobilePlugin,lib:Library) {
	plugin.assertEnabled();
	const store=plugin.store(lib),old=await mobileStatus(store),author=await localAuthor(store);
	const dlg=new Dialog(plugin.app,tr('本库 Git 设置','Library Git settings'));
	const draft={...author};
	dlg.lines([lib.location+'/.git/config',tr('清空姓名或邮箱以继承本设备为此 Vault 设置的对应字段。','Clear a field to inherit its default for this vault on this device.')]);
	const inherit=tr('可留空，继承本设备的 Vault 默认值','Optional · inherit the vault default on this device');
	dlg.text('user.name',author.name,v=>{draft.name=v.trim();},inherit);
	dlg.text('user.email',author.email,v=>{draft.email=v.trim();},inherit);
	dlg.action(tr('预览身份修改','Preview identity changes'),async()=>{
		if([draft.name,draft.email].some(v=>/[<>]/u.test(v)||Array.from(v).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127)))throw new Error(tr('身份含无效字符','Invalid identity characters'));
		const updates:Record<string,string|undefined>={},lines=[lib.location+'/.git/config'];
		for(const k of ['name','email'] as const)if(draft[k]!==author[k]){
			updates['user.'+k]=draft[k]||undefined;
			lines.push('user.'+k+' · '+(author[k]||'∅')+' → '+(draft[k]||tr('继承','Inherit')));
		}
		if(lines.length===1)throw new Error(tr('没有变更','No changes'));
		confirm(plugin,tr('保存提交身份','Save commit identity'),lines,async()=>{
			await plugin.exclusive(lib.location,()=>configure(store,old,updates),lib);
		},()=>dlg.close());
		await Promise.resolve();
	});
	dlg.open();
}
export async function remoteSettings(plugin:MobilePlugin,lib:Library) {
	plugin.assertEnabled();
	const store=plugin.store(lib),old=await mobileStatus(store),current=await upstream(store,old.branch);
	const dlg=new Dialog(plugin.app,tr('本库 HTTPS 远端','Library HTTPS remote'));
	const remote=current?.remote??'origin';
	let url=current?.url??'',branch=current?.branch??old.branch,user='',token='',clear=false;
	dlg.lines([lib.location+'/.git/config',remote]);
	dlg.text(tr('远端 HTTPS 地址','Remote HTTPS URL'),url,v=>{url=v;});
	dlg.text(tr('上游分支','Upstream branch'),branch,v=>{branch=v;});
	dlg.text(tr('认证用户名','Authentication username'),'',v=>{user=v;});
	tokenField(dlg,v=>{token=v;});
	new Setting(dlg.contentEl).setName(tr('清除这个地址的已保存令牌','Clear saved token for this address')).addToggle(c=>c.onChange(v=>{clear=v;}));
	dlg.action(tr('预览','Preview'),async()=>{
		const addr=endpoint(url),ref=branchName(branch),id=lib.identity!.id,key=await secretKey(id,addr);
		const credential=token?JSON.stringify({username:user||'git',password:token}):undefined,remove=clear;
		const updates={['remote.'+remote+'.url']:addr,['remote.'+remote+'.fetch']:'+refs/heads/*:refs/remotes/'+remote+'/*',
			['branch.'+old.branch+'.remote']:remote,['branch.'+old.branch+'.merge']:'refs/heads/'+ref};
		if(remove && credential)throw new Error(tr('请选择更新或清除令牌','Choose either update or clear token'));
		confirm(plugin,tr('确认远端设置','Confirm remote settings'),[lib.location,remote,(current?.url??'∅')+' → '+addr,
			(current?.branch??'∅')+' → '+ref,remove?tr('清除本设备令牌','Clear device token'):credential?tr('更新本设备令牌','Update device token'):tr('保留凭据','Keep credentials')],async()=>{
			await plugin.exclusive(lib.location,async()=>{
				await configure(store,old,updates);
				if(remove || credential)plugin.app.secretStorage.setSecret(key,credential??'');
			},lib);
		},()=>dlg.close());
	});
	dlg.open();
}
