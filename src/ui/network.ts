import {digest} from '../fs/vault.ts';
import {fromEnglish} from '../i18n.ts';
import {gitDisabled,pluginNotice} from './device.ts';
import {moment,Notice,Setting} from 'obsidian';
import {hostname} from 'node:os';
import {renderCommitMessage} from '../preferences.ts';
import {AutomationClock,selectPaths} from '../git/network-automation.ts';
import type KnowledgeBaseManager from '../main.ts';
import {discover,recheck} from '../kb/catalog.ts';
import type {Library} from '../kb/catalog.ts';
import {Dialog} from './dialog.ts';
import {applyChange,bindRemote,bindingPlan,changePlan,createBranch,remoteState,secretKey,transfer} from '../git/network.ts';
import type {AutomationGrant,RemoteTarget,Credentials} from '../git/network.ts';
import {history,saveVersion} from '../git/versions.ts';
import {mergePanel} from './network-merge.ts';
import {commitRoles} from './repository-identity.ts';
import {deletionPlan,removeBranch,remoteRemoval,removeRemote,serverBranches,trackBranch} from '../git/network-refs.ts';

const pulledFiles=new WeakMap<KnowledgeBaseManager,Map<string,string[]>>();
export function recordPull(plugin:KnowledgeBaseManager,id:string,files:string[]){
	let records=pulledFiles.get(plugin);
	if(!records){records=new Map();pulledFiles.set(plugin,records);}
	records.set(id,files);
}

function mode(plugin:KnowledgeBaseManager,id:string,url:string){
 return url.startsWith('https://') && plugin.app.loadLocalStorage(secretKey(id,url)+'-enabled')===true?'fallback':'system';
}
export function credential(plugin:KnowledgeBaseManager,id:string,target:RemoteTarget,push=false):Credentials|undefined {
 const url=push?target.pushUrl:target.url;
 if(mode(plugin,id,url)==='system')return undefined;
 const raw=plugin.app.secretStorage.getSecret(secretKey(id,url));
 if(!raw)throw new Error(plugin.t('未找到已选用的备用凭据','The selected fallback credential is unavailable'));
	const data:unknown=JSON.parse(raw);
	if(typeof data!=='object'||!data||!('username' in data)||!('password' in data)||
		typeof data.username!=='string'||typeof data.password!=='string')throw new Error(fromEnglish('Invalid repository credential','本库凭据无效'));
	return {username:data.username,password:data.password};
}

function grantFor(plugin:KnowledgeBaseManager,lib:Library,state:Awaited<ReturnType<typeof remoteState>>):AutomationGrant {
	const p=plugin.preferences(lib.identity!.id);
	return {location:lib.location,branch:state.preview.branch,remote:state.target?.remote??'',
		routeDigest:state.target && (p.autoPullMinutes || p.autoPushMinutes || p.autoPullOnStart)?digest(JSON.stringify([state.target.signature,mode(plugin,lib.identity!.id,state.target.url),mode(plugin,lib.identity!.id,state.target.pushUrl)])):'',
		remoteBranch:state.target?.remoteBranch??'',commit:p.autoCommitMinutes,pull:p.autoPullMinutes,push:p.autoPushMinutes,
		autoGlobs:p.autoGlobs,autoGlobMode:p.autoGlobMode,autoAfterEdits:p.autoAfterEdits,autoFromLastCommit:p.autoFromLastCommit,autoPullOnStart:p.autoPullOnStart};
}

export async function networkPanel(plugin:KnowledgeBaseManager,lib:Library,el:HTMLElement,register?:(icon:string,open:()=>Promise<void>)=>void){
	if(!lib.identity || lib.duplicate || lib.problem || lib.git!=='local'||lib.identity.archived)return;
	const id=lib.identity.id,t=(zh:string,en:string)=>plugin.t(zh,en);
	await recheck(plugin.disk,plugin.config,lib);
	if(await mergePanel(plugin,lib,el,await plugin.disk.path(lib.location)))return;
	const write=async<T>(action:(dir:string)=>Promise<T>)=>plugin.exclusiveGit(lib.location,async()=>{
		await recheck(plugin.disk,plugin.config,lib);
		return action(await plugin.disk.path(lib.location));
	});
	const preview=async(title:string)=>{
		await recheck(plugin.disk,plugin.config,lib);
		const dir=await plugin.disk.path(lib.location),state=await remoteState(dir);
		const dialog=new Dialog(plugin.app,title);
		dialog.lines([lib.location,state.preview.branch+' · '+(state.preview.head.slice(0,10)||'∅')]);
		const confirm=(label:string, action:(dir:string)=>Promise<void>)=>{
			dialog.action(label,async()=>{
				await write(async folder=>{
					const fresh=await remoteState(folder);
					if(fresh.preview.signature!==state.preview.signature || JSON.stringify(fresh.target)!==JSON.stringify(state.target))
						throw new Error(t('仓库已变化，请重新预览','Repository changed. Preview again.'));
					await action(folder);
				});
				dialog.close();await plugin.refresh();
			});
		};
		return {dir,state,dialog,confirm};
	};
	const row=new Setting(el);
	function button(icon:string,label:string,open:()=>Promise<void>){
		register?.(icon,open);
		row.addExtraButton(b=>b.setIcon(icon).setTooltip(label).onClick(()=>{
			void open().catch((e:unknown)=>pluginNotice(plugin,'error',String(e),id,8000));
		}));
	}
	const prefs=plugin.preferences(id);
	for(const op of ['fetch','pull','push'] as const){
		const title={fetch:t('获取','Fetch'),pull:t('拉取','Pull'),push:t('推送','Push')}[op];
		button({fetch:'cloud-download',pull:'arrow-down',push:'arrow-up'}[op],title,async()=>{
			const {state,dialog,confirm}=await preview(title);
			const target=state.target;
			if(!target)throw new Error(t('请先配置本库远端','Configure this library’s remote first.'));
			dialog.lines([op==='push'?target.pushDisplay:target.fetchDisplay,target.remote+' / '+target.remoteBranch,mode(plugin,id,op==='push'?target.pushUrl:target.url)]);
			confirm(op==='pull'?t('获取并预览','Fetch and preview'):title,async dir=>{
				await transfer(dir,op==='push'?'push':'fetch',target,credential(plugin,id,target,op==='push'));
				if(op==='pull'){
					const plan=await changePlan(dir,'refs/remotes/'+target.remote+'/'+target.remoteBranch);
					const next=new Dialog(plugin.app,t('确认拉取','Confirm pull'));
					next.lines([lib.location,plan.head.slice(0,10)+' → '+plan.oid.slice(0,10),prefs.syncMethod,...commitRoles(plan.identity,prefs.syncMethod),
						...(prefs.syncMethod==='merge'?[t('冲突策略','Conflict strategy')+' · '+prefs.mergeStrategy]:[]),...plan.changes]);
					next.action(t('应用','Apply'),async()=>{
						await write(async folder=>{
							if(JSON.stringify((await remoteState(folder)).target)!==JSON.stringify(target))throw new Error(fromEnglish('Remote changed','远端已变化'));
							await applyChange(folder,plan,'pull',prefs.syncMethod,prefs.mergeStrategy);
							recordPull(plugin,id,plan.changes);
						});
						next.close();await plugin.refresh();
					});next.open();
				}
			});dialog.open();
		});
	}
	button('git-branch',t('分支','Branches'),async()=>{
		const {dir,state,dialog,confirm}=await preview(t('本库分支','Library branches'));
		let name='';
		dialog.text(t('新分支名','New branch name'),name,v=>{name=v;});
		confirm(t('创建分支','Create branch'),folder=>createBranch(folder,name));
		for(const branch of state.branches.filter(b=>b!==state.preview.branch)){
			dialog.action(branch,async()=>{
				const plan=await changePlan(dir,'refs/heads/'+branch);
				const next=new Dialog(plugin.app,t('切换分支','Switch branch'));
				next.lines([lib.location,state.preview.branch+' → '+branch,...plan.changes]);
				next.action(t('切换','Switch'),async()=>{
					await write(folder=>applyChange(folder,plan,'switch',prefs.syncMethod));
					next.close();dialog.close();await plugin.refresh();
				});next.open();
			});
			dialog.action(t('删除已合并分支','Delete merged branch')+' · '+branch,async()=>{
				const plan=await deletionPlan(dir,branch);
				const next=new Dialog(plugin.app,t('删除本地分支','Delete local branch'));
				next.lines([lib.location,plan.branch+' · '+plan.tip,t('已合入','Merged into')+' '+plan.current+' · '+plan.head]);
				next.action(t('删除此分支','Delete this branch'),async()=>{
					await write(folder=>removeBranch(folder,plan));next.close();dialog.close();await plugin.refresh();
				});next.open();
			});
		}
		const target=state.target;
		if(target)dialog.action(t('获取远端分支列表','List branches on remote')+' · '+target.url,async()=>{
			const branches=await serverBranches(dir,target,credential(plugin,id,target));
			const list=new Dialog(plugin.app,t('选择要跟踪的分支','Choose a branch to track'));
			list.lines([lib.location,target.url]);
			for(const branch of branches)list.action(branch.name,async()=>{
				const next=new Dialog(plugin.app,t('创建本地跟踪分支','Create tracking branch'));
				let localName=branch.name;
				next.lines([lib.location,target.remote+'/'+branch.name+' · '+branch.oid]);
				next.text(t('本地分支名称','Local branch name'),localName,v=>{localName=v;});
				next.action(t('创建分支并设置上游','Create branch and set upstream'),async()=>{
					await write(folder=>trackBranch(folder,target,branch,localName,credential(plugin,id,target)));
					next.close();list.close();dialog.close();await plugin.refresh();
				});next.open();await Promise.resolve();
			});list.open();
		});
		dialog.open();
	});
	button('settings-2',t('本库远端与凭据','Library remote and credentials'),async()=>{
		const {dir,state,dialog}=await preview(t('本库远端与凭据','Library remote and credentials'));
		let remote=state.target?.remote??'origin',url=state.target?.url??'',branch=state.target?.remoteBranch??state.preview.branch;
		dialog.lines(state.remotes.map(r=>r.remote));
		dialog.text(t('远端名称','Remote name'),remote,v=>{remote=v;});
		dialog.text('URL',url,v=>{url=v;});
		dialog.text(t('上游分支','Upstream branch'),branch,v=>{branch=v;});
		dialog.action(t('预览上游修改','Preview upstream changes'),async()=>{
			const plan=await bindingPlan(dir,state.preview.branch,remote,url,branch);
			const next=new Dialog(plugin.app,t('确认上游修改','Confirm upstream changes'));
			const before=plan.oldBranch?.replace(/^refs\/heads\//u,'');
			next.lines([lib.location+' · '+plan.branch,
				t('上游','Upstream')+' · '+(plan.oldUpstream && before?plan.oldUpstream+'/'+before:'∅')+' → '+plan.remote+'/'+plan.remoteBranch,
				t('获取','Fetch')+' · '+(plan.old?.display??'∅')+' → '+plan.fetch.display,
				t('推送','Push')+' · '+(plan.oldPush?.display??'∅')+' → '+(plan.push?.display??'∅')]);
			next.action(t('保存本库上游','Save library upstream'),async()=>{
				await write(folder=>bindRemote(folder,plan.branch,plan.remote,plan.fetch.url,plan.remoteBranch,plan));
				const grant=plugin.grants[id];
				if(grant && (grant.push || grant.pull || grant.autoPullOnStart) && JSON.stringify(grant)!==JSON.stringify(grantFor(plugin,lib,await remoteState(dir)))){
					grant.paused='review';await plugin.persist();
				}
				next.close();dialog.close();await plugin.refresh();
			});next.open();
		});
		const urls=new Set(state.target?[state.target.url,state.target.pushUrl]:[]);
		for(const endpoint of urls){
			if(!endpoint.startsWith('https://'))continue;
			dialog.action(t('认证方式','Authentication')+' · '+endpoint,async()=>{
				const form=new Dialog(plugin.app,t('本库 HTTPS 认证','Library HTTPS authentication'));
				const key=secretKey(id,endpoint);
				let enabled=mode(plugin,id,endpoint)==='fallback',user='',token='';
				form.lines([lib.location,endpoint,t('默认使用系统 Git 凭据助手。备用令牌只用于此库和此 HTTPS 地址。','System Git credential helpers are the default. The fallback applies only to this library and HTTPS endpoint.')]);
				new Setting(form.contentEl).setName(t('使用备用凭据','Use fallback credentials')).addToggle(b=>b.setValue(enabled).onChange(v=>{enabled=v;}));
				form.text(t('备用用户名','Fallback username'),'',v=>{user=v;});
				new Setting(form.contentEl).setName(t('备用令牌（留空保留）','Fallback token (leave empty to keep)')).addText(field=>{
					field.inputEl.type='password';field.onChange(v=>{token=v;});
				});
				form.action(t('保存认证方式','Save authentication mode'),async()=>{
					await write(async dir=>{
						const now=(await remoteState(dir)).target;
						if(!now || (now.url!==endpoint && now.pushUrl!==endpoint))throw new Error(t('端点已变化','Endpoint changed'));
						if(enabled && !token && !plugin.app.secretStorage.getSecret(key))throw new Error(t('需要备用令牌','A fallback token is required'));
						if(token)plugin.app.secretStorage.setSecret(key,JSON.stringify({username:user||'git',password:token}));
						plugin.app.saveLocalStorage(key+'-enabled',enabled);
					});
					form.close();dialog.close();await plugin.refresh();
				});
				form.action(t('清除备用凭据并使用系统认证','Clear fallback and use system authentication'),async()=>{
					plugin.app.saveLocalStorage(key+'-enabled',false);plugin.app.secretStorage.setSecret(key,'');
					form.close();dialog.close();await plugin.refresh();
				});
				form.open();await Promise.resolve();
			});
		}
		for(const item of state.remotes)dialog.action(t('移除本地远端配置','Remove local remote configuration')+' · '+item.remote,async()=>{
			const plan=await remoteRemoval(dir,item.remote);
			const next=new Dialog(plugin.app,t('确认移除本库远端配置','Confirm removal of library remote'));
			next.lines([lib.location,item.remote,t('以下本地分支会取消上游绑定','These local branches will lose their upstream binding'),...plan.affected,
				t('本地跟踪引用与服务器上的提交将保留','Local tracking refs and commits on the server will be retained.')]);
			next.action(t('移除','Remove'),async()=>{
				await write(folder=>removeRemote(folder,plan));next.close();dialog.close();await plugin.refresh();
			});next.open();
		});
		dialog.open();
	});
	button('timer',t('授权本库自动操作','Authorize library automation'),async()=>{
		const {state,dialog,confirm}=await preview(t('本库自动操作','Library automation'));
		const grant=grantFor(plugin,lib,state),previous=plugin.grants[id];
		dialog.lines([...(state.target?[state.target.fetchDisplay,state.target.pushDisplay,mode(plugin,id,state.target.url)+' / '+mode(plugin,id,state.target.pushUrl)]:[]),grant.remoteBranch,t('自动暂存的文件规则','Automatic staging rules')+' · '+grant.autoGlobMode+' · '+grant.autoGlobs,
			t('当前匹配的变更','Currently matching changes')+': '+selectPaths(grant.autoGlobMode,grant.autoGlobs,state.preview.changes.map(c=>c.file)).join(', '),
			t('推送会发送此分支的待推送提交','Push sends all unpublished commits on this branch.'),
			t('停止编辑后计时 / 从上次提交计时 / 启动拉取','After edits / from last commit / pull on startup')+' · '+[grant.autoAfterEdits,grant.autoFromLastCommit,grant.autoPullOnStart].join(' / '),
			t('间隔（分钟）：提交 / 拉取 / 推送','Minutes: commit / pull / push')+' · '+[grant.commit,grant.pull,grant.push].join(' / '),
			(previous?.paused?t('已暂停，请复核后重新授权','Paused. Review and authorize again.'):undefined) || (previous?t('已授权','Authorized'):t('未授权','Not authorized'))]);
		if(grant.commit || grant.pull || grant.push || grant.autoPullOnStart)confirm(t('授权以上范围','Authorize this scope'),async dir=>{
			if((grant.pull||grant.push||grant.autoPullOnStart)&&!state.target)throw new Error(t('请先配置本库远端','Configure the library remote first.'));
			if((await remoteState(dir)).preview.staged)throw new Error(t('请先处理暂存内容','Resolve staged changes first.'));
			plugin.grants[id]=grant;await plugin.persist();
		});
		if(previous)confirm(t('撤销授权','Revoke authorization'),async()=>{delete plugin.grants[id];await plugin.persist();});
		dialog.open();
	});
	const files=pulledFiles.get(plugin)?.get(id);
	if(files?.length){
		const group=el.createEl('details');
		group.createEl('summary',{text:t('最近拉取','Last pulled')+' ('+files.length+')'});
		for(const file of files)group.createDiv({text:file});
	}
}

export function startAutomation(plugin:KnowledgeBaseManager){
	const clock=new AutomationClock();
	let running=false,stopped=false;
	plugin.register(()=>{stopped=true;});
	const edited=(file:string)=>{
		for(const grant of Object.values(plugin.grants)){
			const prefix=grant.location+'/';
			if(grant.autoAfterEdits && !grant.paused && file.startsWith(prefix) &&
				selectPaths(grant.autoGlobMode,grant.autoGlobs,[file.slice(prefix.length)]).length)clock.edited(grant,Date.now());
		}
	};
	const onChange=(file:{path:string})=>edited(file.path);
	plugin.registerEvent(plugin.app.vault.on('create',onChange));
	plugin.registerEvent(plugin.app.vault.on('modify',onChange));
	plugin.registerEvent(plugin.app.vault.on('delete',onChange));
	plugin.registerEvent(plugin.app.vault.on('rename',(file,old)=>{edited(old);edited(file.path);}));
	const tick=async(startup=false)=>{
		if(stopped || running || gitDisabled(plugin))return;
		const active=Object.entries(plugin.grants).filter(([,g])=>!g.paused);
		if(!active.length)return;
		running=true;
		try{
			const libs=await discover(plugin.disk,plugin.config);
			for(const [id,grant] of active){
				if(stopped)return;
				try{
					const lib=libs.find(l=>l.identity?.id===id && l.location===grant.location);
					if(!lib || !lib.identity || lib.identity.archived || lib.duplicate || lib.problem)throw new Error(fromEnglish('Library identity or location changed','知识库身份或位置已变化'));
					const dir=await plugin.disk.path(lib.location);
					const latest=grant.autoFromLastCommit && grant.commit?(await history(dir,undefined,1)).entries[0]?.commit.committer.timestamp:undefined;
					const ops=clock.due(grant,Date.now(),latest===undefined?undefined:latest*1000,startup);
					if(!ops.length)continue;
					await plugin.exclusiveGit(lib.location,async()=>{
						const prefs=plugin.preferences(id);
						for(const op of ops){
							if(stopped || gitDisabled(plugin) || plugin.grants[id]!==grant)return;
							await recheck(plugin.disk,plugin.config,lib);
							const state=await remoteState(dir);
							if(JSON.stringify(grantFor(plugin,lib,state))!==JSON.stringify(grant))throw new Error(fromEnglish('Authorized branch, remote or automation settings changed','已授权的分支、远端或自动化设置已变化'));
							if(state.preview.staged)throw new Error(fromEnglish('Index already contains staged changes','索引已有暂存内容'));
							const selected=selectPaths(grant.autoGlobMode,grant.autoGlobs,state.preview.changes.map(c=>c.file));
							if(op==='commit' && selected.length){
								const message=renderCommitMessage({...prefs,commitMessage:prefs.autoCommitMessage},moment().format(prefs.commitDateFormat),
									hostname(),selected);
								await saveVersion(dir,state.preview,message,async receipt=>{
									plugin.saves[id]=receipt;await plugin.persist();
								},'smart',new Set(selected));
							}else if(op!=='commit'){
								if(!state.target)throw new Error(fromEnglish('No upstream configured','尚未设置上游分支'));
								await transfer(dir,op==='pull'?'fetch':'push',state.target,credential(plugin,id,state.target,op==='push'));
								if(op==='pull' && !stopped && !gitDisabled(plugin) && plugin.grants[id]===grant){
									const plan=await changePlan(dir,'refs/remotes/'+grant.remote+'/'+grant.remoteBranch);
									await recheck(plugin.disk,plugin.config,lib);
									await applyChange(dir,plan,'pull','ff-only');
									recordPull(plugin,id,plan.changes);
								}
							}
							clock.completed(grant,op,Date.now());
						}
					});
				}catch(error){
					if(plugin.grants[id]===grant){
						grant.paused='failed';await plugin.persist();
						pluginNotice(plugin,'error',plugin.t('自动操作已暂停','Automation paused')+' · '+grant.location+' · '+String(error),id,8000);
					}
				}
			}
		}finally{running=false;}
	};
	plugin.registerInterval(window.setInterval(()=>{void tick().catch((error:unknown)=>new Notice(String(error)));},30000));
	plugin.app.workspace.onLayoutReady(()=>{void tick(true).catch((error:unknown)=>new Notice(String(error)));});
}
