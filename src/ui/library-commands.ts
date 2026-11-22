import { MarkdownView,Notice } from 'obsidian';
import type KnowledgeBaseManager from '../main.ts';
import { discover } from '../kb/catalog.ts';
import type { Library } from '../kb/catalog.ts';
import { Dialog } from './dialog.ts';
import { assertGitEnabled,pluginNotice } from './device.ts';
import { commitAndSync } from './sync.ts';
import { cloneWizard } from './clone.ts';
import { manageRegistry } from './manager-registry.ts';

const operations=[
	['status','本库 Git 状态','Library Git status',''],
	['fetch','获取本库远端','Fetch library upstream','cloud-download'],
	['pull','拉取本库','Pull library','arrow-down'],
	['push','推送本库','Push library','arrow-up'],
	['branches','管理本库分支','Manage library branches','git-branch'],
	['remote','设置本库远端','Configure library upstream','settings-2'],
	['automation','管理本库自动操作','Manage library automation','timer'],
	['sync','提交并同步本库','Commit and sync library',''],
	['sync-close','同步后关闭当前笔记','Sync library and close current note',''],
	['clone','克隆知识库','Clone library',''],
] as const;

export function registerLibraryCommands(plugin:KnowledgeBaseManager,reload:boolean){
	const t=plugin.t;
	if(reload)plugin.removeCommand('library-registry');
	plugin.addCommand({id:'library-registry',name:t('管理 Vault 知识库登记','Manage Vault library registry'),callback:()=>manageRegistry(plugin)});
	for(const [key,zh,en,icon] of operations){
		const id='library-'+key;
		if(reload)plugin.removeCommand(id);
		plugin.addCommand({id,name:t(zh,en),callback:async()=>{
			try{
				assertGitEnabled(plugin);
				if(key==='clone'){cloneWizard(plugin);return;}
				const workspace=plugin.app.workspace, file=workspace.getActiveFile();
				const editor=workspace.getActiveViewOfType(MarkdownView);
				const libs=(await discover(plugin.disk,plugin.config)).filter(l=>l.identity && !l.problem && !l.duplicate);
				const active=libs.find(l=>file?.path.startsWith(l.location+'/'));
				async function run(lib:Library){
					if(key==='sync' || key==='sync-close'){
						if(key==='sync'){await commitAndSync(plugin,lib);return;}
						if(!editor || !file || active!==lib)throw new Error(t('请先打开本库笔记','Open a note from this library first'));
						const confirm=new Dialog(plugin.app,t(zh,en));
						confirm.lines([file.path,lib.location]);
						confirm.action(t('继续','Continue'),async()=>{
							confirm.close();
							await commitAndSync(plugin,lib,undefined,undefined,'smart',()=>{
								if(editor.leaf.view===editor && editor.file===file)editor.leaf.detach();
							});
						});
						confirm.open();return;
					}
					const view=await plugin.openManager();
					if(icon)await view.runNetworkAction(lib.identity!.id,icon);
					else await view.showLibrary(lib.identity!.id);
				}
				if(active){await run(active);return;}
				if(!libs.length){new Notice(t('尚无可操作的知识库','No eligible libraries'));return;}
				const picker=new Dialog(plugin.app,t('选择知识库','Choose a library'));
				for(const lib of libs)picker.action(lib.location,async()=>{picker.close();await run(lib);});
				picker.open();
			}catch(error){pluginNotice(plugin,'error',String(error),undefined,8000);}
		}});
	}
}
