import type KnowledgeBaseManager from '../main.ts';
import { recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { indirectIdentityMessage, readRepositoryIdentity, requireIdentity, writeRepositoryIdentity } from '../git/identity.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled } from './device.ts';

export async function editRepositoryIdentity(plugin:KnowledgeBaseManager,lib:Library) {
	assertGitEnabled(plugin);
	const current=await recheck(plugin.disk,plugin.config,lib);
	if(current.git!=='local')throw new Error(plugin.t('请先初始化本库 Git','Initialize Git in this library first'));
	const dir=await plugin.disk.path(current.location);
	const before=await readRepositoryIdentity(dir);
	const t=plugin.t, target=current.location+'/.git/config';
	const dialog=new Dialog(plugin.app,t('本库 Git 提交身份','Library Git commit identity'));
	dialog.lines([target]);
	if(before.identity.indirect || current.identity?.archived){
		dialog.lines(['user.name · '+(before.identity.name || '—'),'user.email · '+(before.identity.email || '—')]);
		if(before.identity.indirect)dialog.lines([indirectIdentityMessage()]);
	}else{
		const draft={...before.identity};
		dialog.text('user.name',draft.name,value=>{draft.name=value;});
		dialog.text('user.email',draft.email,value=>{draft.email=value;});
		dialog.action(t('预览修改','Preview changes'),()=>{
			const next=requireIdentity(draft);
			if(next.name===before.identity.name && next.email===before.identity.email)throw new Error(t('没有待保存的修改','No changes to save'));
			const preview=new Dialog(plugin.app,t('确认修改 Git 提交身份','Confirm Git identity changes'));
			preview.lines([target,...(['name','email'] as const).filter(key=>before.identity[key]!==next[key])
				.map(key=>'user.'+key+' · '+(before.identity[key] || t('未设置','Unset'))+' → '+next[key])]);
			preview.action(t('写入本库 Git 配置','Save to library Git config'),async()=>{
				await plugin.exclusiveGit(lib.location,async()=>{
					await recheck(plugin.disk,plugin.config,current);
					await writeRepositoryIdentity(await plugin.disk.path(current.location),before,next);
				});
				preview.close();dialog.close();
				await plugin.refresh();
			});
			preview.open();
			return Promise.resolve();
		});
	}
	dialog.open();
}
