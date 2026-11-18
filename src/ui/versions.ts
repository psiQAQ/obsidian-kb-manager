import type KnowledgeBaseManager from '../main.ts';
import { discover, recheck } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { history, previewVersion, saveVersion } from '../git/versions.ts';
import { initializeRepository } from '../git/repository.ts';
import { Dialog } from './dialog.ts';

export async function versions(plugin: KnowledgeBaseManager, lib: Library, mode:'save'|'history') {
	await recheck(plugin.disk,plugin.config,lib);
	const dir=await plugin.disk.path(lib.location);
	const dialog=new Dialog(plugin.app,mode==='save'?'保存本库版本':'本库历史');
	dialog.lines([lib.identity?.displayName ?? '',lib.location]);
	if(lib.git==='missing'){
		dialog.lines(['此库没有 Git 历史。初始化将创建 .git/ 和 main 分支。']);
		if(!lib.identity?.archived)dialog.action('初始化本地 Git',async()=>{
			await plugin.exclusive(lib.location,async()=>{
				await recheck(plugin.disk,plugin.config,lib);
				await initializeRepository(dir);
			});
			dialog.close();await plugin.refresh();
		});
	} else if(mode==='history'){
		let cursor: string | undefined;
		const page=async()=>{
			await recheck(plugin.disk,plugin.config,lib);
			const data=await history(dir,cursor);
			dialog.lines(data.entries.map(e=>e.oid.slice(0,10)+' · '+e.commit.author.name+' · '+
				new Date(e.commit.author.timestamp*1000).toLocaleString()+' · '+e.commit.message.trim()));
			cursor=data.next;
			if(!data.entries.length){
				dialog.lines(['还没有提交。']);
				if(!lib.identity?.archived)dialog.action('预览首个版本',async()=>{dialog.close();await versions(plugin,lib,'save');});
			}
		};
		await page();
		if(cursor)dialog.action('下一页',async()=>{if(cursor)await page();});
	} else {
		if(lib.identity?.archived)throw new Error('请先恢复此库');
		const preview=await previewVersion(dir);
		const previous=lib.identity && plugin.saves[lib.identity.id];
		if(previous && !previous.committed)dialog.lines([
			previous.candidate===preview.head?'上次提交已写入：'+preview.head:'上次操作尚未确认完成，当前 HEAD：'+(preview.head||'空'),
			'上次说明：'+previous.message,'已记录暂存：'+(previous.staged.join('、')||'无'),previous.problem??'',
		]);
		dialog.lines([preview.branch+' · '+(preview.head.slice(0,10)||'无提交'),
			preview.staged?'仅提交索引中已暂存的内容；其余工作区变更留待下次保存。':'将暂存并提交下列变更。已忽略且未跟踪的文件跳过。',
			preview.platform+' · 扫描 '+preview.files+' 个文件；读取变更内容 '+preview.bytes+' 字节；'+preview.elapsed+' ms',
			...preview.changes.map(c=>c.file+' · 索引 '+state(c.head,c.stage)+' · 工作区 '+(c.stage===3?'有其他内容':state(c.stage,c.work)))]);
		if(preview.changes.length){
			let message='',name=plugin.config.author,email=plugin.config.email;
			dialog.text('提交说明','',v=>{message=v;});
			dialog.text('本地作者',name,v=>{name=v;});dialog.text('邮箱',email,v=>{email=v;});
			dialog.action(preview.staged?'提交已暂存内容':'保存此版本',async()=>{
				const oid=await plugin.exclusive(lib.location,async()=>{
					await recheck(plugin.disk,plugin.config,lib);
					return saveVersion(dir,preview,message,{name,email},async receipt=>{
						if(!lib.identity)throw new Error('库身份已失效');
						plugin.saves[lib.identity.id]=receipt;
						await plugin.persist();
					});
				});
				dialog.contentEl.empty();dialog.lines([lib.location,'已提交 '+oid]);
			});
		}else dialog.lines(['没有待提交内容']);
	}
	dialog.open();
}

function state(before:number,after:number){
	if(before===after)return '无变化';
	return after===0?'删除':before===0?'新增':'修改';
}

export async function activeVersion(plugin: KnowledgeBaseManager, mode:'save'|'history'){
	const libs=(await discover(plugin.disk,plugin.config)).filter(l=>l.identity && !l.problem && !l.duplicate);
	const file=plugin.app.workspace.getActiveFile()?.path;
	const target=file ? libs.find(l=>file.startsWith(l.location+'/')) : undefined;
	if(target){await versions(plugin,target,mode);return;}
	const selector=new Dialog(plugin.app,'选择目标知识库');
	for(const lib of libs)selector.action(lib.location,async()=>{selector.close();await versions(plugin,lib,mode);});
	if(!libs.length)selector.lines(['没有可选的知识库，请检查管理器中的冲突或发现结果。']);
	selector.open();
}
