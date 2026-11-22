import { tr } from '../i18n.ts';
import { randomUUID } from 'node:crypto';
import type KnowledgeBaseManager from '../main.ts';
import { discover, identityFile, parseIdentity, writeIdentity } from '../kb/catalog.ts';
import type { Identity, Library } from '../kb/catalog.ts';
import { readManifestFile, replaceLibraryManifest } from '../kb/manifest-disk.ts';
import { Dialog } from './dialog.ts';

export async function changeIdentity(plugin: KnowledgeBaseManager, lib: Library, transform: (value: Identity)=>void) {
	const relative = lib.location + '/' + identityFile;
	const filename=await plugin.disk.path(relative);
	const {raw,signature}=await readManifestFile(filename);
	if(signature!==lib.signature)throw new Error(tr('清单已变化，请重新预览','Manifest changed. Preview again'));
	const value=parseIdentity(raw);
	transform(value);
	await replaceLibraryManifest(plugin.disk,lib.location,signature,writeIdentity(raw,value));
}

export async function resolveDuplicate(plugin: KnowledgeBaseManager, copy: Library, owner:Window=activeWindow) {
	const duplicates=(await discover(plugin.disk,plugin.config)).filter(x=>x.identity?.id===copy.identity?.id);
	const originals=duplicates.filter(x=>x.location!==copy.location);
	if (!originals.length) throw new Error(tr('冲突状态已变化，请刷新',"Conflict changed. Refresh"));
	let original=originals[0]!.location;
	const dialog=new Dialog(plugin.app,tr('为副本分配新的 ID',"Assign a new ID to the copy"),owner);
	dialog.lines([tr('仅修改 ',"Change only ")+copy.location+'/'+identityFile,tr('旧 ID：',"Previous ID: ")+copy.identity?.id]);
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
