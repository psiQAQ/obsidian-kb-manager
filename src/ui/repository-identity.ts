import type KnowledgeBaseManager from '../main.ts';
import { recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { identityAfter, readRepositoryIdentity, writeRepositoryIdentity } from '../git/identity.ts';
import type { GitIdentity,IdentityValue } from '../git/identity.ts';
import { tr } from '../i18n.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled } from './device.ts';

export function identitySourceText(value?:IdentityValue){
	if(!value)return tr('未设置','Unset');
	const scopes:Record<string,string>={system:tr('系统','System'),global:tr('全局','Global'),local:tr('本库','Local'),
		worktree:tr('工作区','Worktree'),command:tr('命令','Command')};
	return value.value+' · '+(scopes[value.scope]??value.scope)+' · '+value.origin;
}

export function commitRoles(who:GitIdentity,method:'ff-only'|'merge'|'rebase'|'squash'):string[]{
	if(method==='ff-only')return [];
	const label=method==='rebase'
		?tr('变基保留每次提交的原作者。新提交者：','Rebase keeps each original author. New committer: ')
		:tr('新提交的作者和提交者：','Author and committer for new commits: ');
	return [label+(who.name||'—')+' <'+(who.email||'—')+'>'];
}

export async function editRepositoryIdentity(plugin:KnowledgeBaseManager,lib:Library){
	assertGitEnabled(plugin);
	const current=await recheck(plugin.disk,plugin.config,lib);
	if(current.git!=='local')throw new Error(plugin.t('请先初始化本库 Git','Initialize Git in this library first'));
	const before=await readRepositoryIdentity(await plugin.disk.path(current.location));
	const t=plugin.t,target=current.location+'/.git/config',keys=['name','email'] as const;
	const dialog=new Dialog(plugin.app,t('本库 Git 提交身份','Library Git commit identity'));
	dialog.facts([[t('本库配置','Library config'),target],...keys.map(key=>['user.'+key,identitySourceText(before.values[key].at(-1))] as const)]);
	if(before.shared)dialog.lines([t('此库含特殊的本地配置，请使用 Git 修改。','This repository has special local configuration. Edit it with Git.')]);
	if(!before.shared && !current.identity?.archived){
		const draft={...before.local};
		dialog.lines([t('以下为本库覆盖值。留空会删除该字段的本地覆盖，Git 会重新采用其余配置。','Local overrides are shown below. Clear a field to remove its override and use the remaining Git configuration.')]);
		for(const key of keys)dialog.text('user.'+key,draft[key],v=>{draft[key]=v;},t('可留空，跟随系统默认','Optional · use system default'));
		dialog.action(t('预览修改','Preview changes'),()=>{
			const next={name:draft.name.trim(),email:draft.email.trim()};
			const changed=keys.filter(k=>next[k]!==before.local[k] || !next[k] && before.values[k].some(v=>v.direct));
			if(!changed.length)throw new Error(t('没有待保存的修改','No changes to save'));
			const preview=new Dialog(plugin.app,t('确认修改 Git 提交身份','Confirm Git identity changes'));
			preview.lines([target,...changed.map(k=>'user.'+k+' · '+(before.local[k]||t('继承','Inherited'))+' → '+
				(next[k] || t('删除本库覆盖','Remove local override')+' · '+identitySourceText(identityAfter(before,k,'')) ))]);
			preview.action(t('写入本库 Git 配置','Save to library Git config'),async()=>{
				await plugin.exclusiveGit(lib.location,async()=>{
					await recheck(plugin.disk,plugin.config,current);
					await writeRepositoryIdentity(await plugin.disk.path(current.location),before,next);
				});
				preview.close();dialog.close();await plugin.refresh();
			});
			preview.open();return Promise.resolve();
		});
	}
	dialog.open();
}
