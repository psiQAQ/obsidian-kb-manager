import { tr } from '../i18n.ts';
import { TFile } from 'obsidian';
import { randomUUID } from 'node:crypto';
import type KnowledgeBaseManager from '../main.ts';
import { discover, identityFile, parseIdentity } from '../kb/catalog.ts';
import type { Identity, Library } from '../kb/catalog.ts';
import { digest } from '../fs/vault.ts';
import { Dialog } from './dialog.ts';

export async function changeIdentity(plugin: KnowledgeBaseManager, lib: Library, transform: (value: Identity)=>void) {
	const relative = lib.location + '/' + identityFile;
	await plugin.disk.path(relative);
	const file=plugin.app.vault.getAbstractFileByPath(relative);
	if (!(file instanceof TFile)) throw new Error(tr('等待 Obsidian 识别清单后刷新',"Wait for Obsidian to index the manifest and refresh"));
	await plugin.app.vault.process(file,text=>{
		if (digest(text)!==lib.signature?.split('/')[0]) throw new Error(tr('清单已变化，请重新预览',"Manifest changed. Preview again"));
		const value=parseIdentity(text);
		transform(value);
		return JSON.stringify(value,null,2)+'\n';
	});
}

export async function resolveDuplicate(plugin: KnowledgeBaseManager, copy: Library) {
	const duplicates=(await discover(plugin.disk,plugin.config)).filter(x=>x.identity?.id===copy.identity?.id);
	const originals=duplicates.filter(x=>x.location!==copy.location);
	if (!originals.length) throw new Error(tr('冲突状态已变化，请刷新',"Conflict changed. Refresh"));
	let original=originals[0]!.location;
	const dialog=new Dialog(plugin.app,tr('为副本分配新的 ID',"Assign a new ID to the copy"));
	dialog.lines([tr('仅修改 ',"Change only ")+copy.location+'/kb-manager.json',tr('旧 ID：',"Previous ID: ")+copy.identity?.id]);
	dialog.choice(tr('保留旧 ID 的原库',"Original library retaining the ID"),Object.fromEntries(originals.map(x=>[x.location,x.location])),v=>{original=v;});
	dialog.action(tr('确认此目录是副本',"Confirm this directory is the copy"),async()=>{
		const latest=await discover(plugin.disk,plugin.config);
		if (!latest.some(lib=>lib.location===original && lib.identity?.id===copy.identity?.id && lib.duplicate) ||
			!latest.some(lib=>lib.location===copy.location && lib.signature===copy.signature && lib.duplicate)) throw new Error(tr('冲突状态已变化',"Conflict changed"));
		await changeIdentity(plugin,copy,value=>{value.id=randomUUID();});
		dialog.close();await plugin.refresh();
	});
	dialog.open();
}
