import type KnowledgeBaseManager from '../main.ts';
import { recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { identityAfter, readRepositoryIdentity, repositoryIdentityChanges, writeRepositoryIdentity } from '../git/identity.ts';
import type { GitIdentity,IdentityValue } from '../git/identity.ts';
import { tr } from '../i18n.ts';
import { V3Dialog, dialogContents } from './dialog.ts';
import { assertGitEnabled } from './device.ts';
import { changeActions, changeComparison, panelGroup } from './change-preview.ts';

export function identitySourceText(value?:IdentityValue){
	if(!value)return tr('未设置','Unset');
	const scopes:Record<string,string>={system:tr('系统','System'),global:tr('全局','Global'),local:tr('本库','Local'),
		worktree:tr('工作区','Worktree'),command:tr('命令','Command')};
	return (value.value||tr('空值','Empty'))+' · '+(scopes[value.scope]??value.scope)+' · '+value.origin;
}

export function commitRoles(who:GitIdentity,method:'ff-only'|'merge'|'rebase'|'squash'):string[]{
	if(method==='ff-only')return [];
	const label=method==='rebase'
		?tr('变基保留每次提交的原作者。新提交者：','Rebase keeps each original author. New committer: ')
		:tr('新提交的作者和提交者：','Author and committer for new commits: ');
	return [label+(who.name||'—')+' <'+(who.email||'—')+'>'];
}

export async function editRepositoryIdentity(plugin:KnowledgeBaseManager,lib:Library,owner:Window=activeWindow){
	assertGitEnabled(plugin);
	const current=await recheck(plugin.disk,plugin.config,lib);
	if(current.git!=='local')throw new Error(plugin.t('请先初始化本库 Git','Initialize Git in this library first'));
	const before=await readRepositoryIdentity(await plugin.disk.path(current.location));
	const t=plugin.t,target=current.location+'/.git/config',keys=['name','email'] as const;
	const dialog=new V3Dialog(plugin.app,t('本库 Git 提交身份','Library Git commit identity'),owner);
	dialog.facts([[t('本库配置','Library config'),target],...keys.map(key=>['user.'+key,identitySourceText(before.values[key].at(-1))] as const)]);
	dialog.contentEl.createEl('p',{text:t('提交使用的姓名和邮箱会随提交写入 Git 历史。','The name and email used for a commit are recorded in Git history.')});
	if(before.shared)dialog.lines([t('此库含特殊的本地配置，请使用 Git 修改。','This repository has special local configuration. Edit it with Git.')]);
	if(!before.shared && !current.identity?.archived){
		const fields=panelGroup(dialog.contentEl,t('本库覆盖值','Local overrides'));
		const draft={...before.local};
		const capture=()=>({name:draft.name.trim(),email:draft.email.trim()});
		const apply=async(next:GitIdentity,preview?:V3Dialog)=>{
			await plugin.exclusiveGit(current.location,async()=>{
				await recheck(plugin.disk,plugin.config,current);
				await writeRepositoryIdentity(await plugin.disk.path(current.location),before,next);
			});
			preview?.close();dialog.close();await plugin.refresh();
		};
		const review=(origin:HTMLButtonElement)=>{
			const next=capture(),changed=repositoryIdentityChanges(before,next);
			const preview=new V3Dialog(plugin.app,t('预览 Git 提交身份变更','Review Git identity changes'),owner).returnFocusTo(origin);
			preview.facts([[t('写入位置','Save to'),target]]);
			changeComparison(preview.contentEl,changed.map(key=>{
				const prior=before.values[key].at(-1),local=before.values[key].filter(value=>value.direct).at(-1);
				const effective=identityAfter(before,key,next[key]);
				return {
					label:'user.'+key,
					before:identitySourceText(prior)+(local && local!==prior?'\n'+identitySourceText(local):''),
					after:identitySourceText(effective)+(next[key] && !effective?.direct?'\n'+next[key]+' · '+t('本库','Local')+' · .git/config':''),
					...(!next[key] && {afterLabel:t('变更后 · 移除本库覆盖','After · Remove local override')}),
				};
			}));
			changeActions(preview.contentEl,[{label:t('应用变更','Apply changes'),run:()=>apply(next,preview),primary:true}]);
			preview.open();return Promise.resolve();
		};
		for(const key of keys)dialogContents(fields).text('user.'+key,draft[key],value=>{
			draft[key]=value;
			actions.setDisabled(!repositoryIdentityChanges(before,draft).length);
		},t('留空时继承 Git 配置','Leave empty to inherit Git configuration'));
		const actions=changeActions(fields,[
			{label:t('预览变更','Preview changes'),run:review},
			{label:t('直接应用','Apply directly'),run:()=>apply(capture()),primary:true},
		]);
		actions.setDisabled(!repositoryIdentityChanges(before,draft).length);
	}
	dialog.open();
}
