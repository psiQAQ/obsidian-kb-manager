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
	if (!(file instanceof TFile)) throw new Error('等待 Obsidian 识别清单后刷新');
	await plugin.app.vault.process(file,text=>{
		if (digest(text)!==lib.signature?.split('/')[0]) throw new Error('清单已变化，请重新预览');
		const value=parseIdentity(text);
		transform(value);
		return JSON.stringify(value,null,2)+'\n';
	});
}

export async function resolveDuplicate(plugin: KnowledgeBaseManager, copy: Library) {
	const duplicates=(await discover(plugin.disk,plugin.config)).filter(x=>x.identity?.id===copy.identity?.id);
	const originals=duplicates.filter(x=>x.location!==copy.location);
	if (!originals.length) throw new Error('冲突状态已变化，请刷新');
	let original=originals[0]!.location;
	const dialog=new Dialog(plugin.app,'为副本分配新的 ID');
	dialog.lines(['仅修改 '+copy.location+'/kb-manager.json','旧 ID：'+copy.identity?.id]);
	dialog.choice('保留旧 ID 的原库',Object.fromEntries(originals.map(x=>[x.location,x.location])),v=>{original=v;});
	dialog.action('确认此目录是副本',async()=>{
		const latest=await discover(plugin.disk,plugin.config);
		if (!latest.some(lib=>lib.location===original && lib.identity?.id===copy.identity?.id && lib.duplicate) ||
			!latest.some(lib=>lib.location===copy.location && lib.signature===copy.signature && lib.duplicate)) throw new Error('冲突状态已变化');
		await changeIdentity(plugin,copy,value=>{value.id=randomUUID();});
		dialog.close();await plugin.refresh();
	});
	dialog.open();
}
