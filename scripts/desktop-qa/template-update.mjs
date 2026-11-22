import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pluginId} from '../desktop-qa-host.mjs';

export async function verifyTemplateUpdate({fixture,scenario,observe,modalButton,libraryMenu,evaluate,source}) {
	await scenario('templaterExpansion',async()=>{
		const path='Beta/Templater probe.md';
		await evaluate(async path=>{
			const note=await window.app.vault.create(path,'# <% tp.file.title %>\n');
			await window.app.workspace.getLeaf('tab').openFile(note,{state:{mode:'source'}});
		},path);
		await observe('Templater command in an active editor',path=>{
			if(window.app.workspace.getActiveFile()?.path!==path)return;
			return window.app.commands.executeCommandById('templater-obsidian:replace-in-file-templater');
		},path);
		const expanded=await observe('expanded Templater expression',async path=>{
			const text=await window.app.vault.read(window.app.vault.getFileByPath(path));
			if(text.trim()==='# Templater probe')return text.trim();
		},path);
		return {path,expanded};
	});
	await scenario('managedTemplateUpdate',async()=>{
		await evaluate(async source=>{
			const write=(path,text)=>window.app.vault.modify(window.app.vault.getFileByPath(path),text);
			const manifest=window.app.vault.getFileByPath(source+'/kb-template.json');
			const spec=JSON.parse(await window.app.vault.read(manifest));
			await write(source+'/Guide.md','Pack guide v2\n');
			await write(source+'/Policy.md','Pack policy v2\n');
			await write('Alpha/Policy.md','My edited policy\n');
			await window.app.vault.modify(manifest,JSON.stringify({...spec,version:'2'}));
		},source);
		await libraryMenu('Alpha','Update template files');
		await modalButton('Preview update');
		const preview=await observe('managed file preview and local conflict',()=>{
			const text=[...document.querySelectorAll('.modal')].at(-1)?.innerText;
			if(text?.includes('Conflict') && text.includes('Replace'))return text;
		});
		assert(preview.includes('Guide.md') && preview.includes('Policy.md'));
		const conflict=await evaluate(()=>{
			const file=[...document.querySelectorAll('.modal details')].find(item=>item.querySelector('summary')?.textContent.includes('Policy.md'));
			return [...file.querySelectorAll('.kb-change-side')].map(side=>[side.querySelector('dt').textContent,side.querySelector('dd').textContent]);
		});
		assert.deepEqual(conflict,[['Before','My edited policy\n'],['Template candidate','Pack policy v2\n']]);
		await modalButton('Apply managed file updates');
		await observe('safe template update',async()=>await window.app.vault.adapter.read('Alpha/Guide.md')==='Pack guide v2\n');
		const read=path=>readFile(join(fixture.vault,path),'utf8');
		assert.equal(await read('Alpha/Policy.md'),'My edited policy\n');
		assert.equal(await read('Beta/Guide.md'),'Pack guide v1\n');
		assert.equal(await read('Beta/Policy.md'),'Pack policy v1\n');
		await observe('managed update finished and its dialogs closed',()=>!document.querySelector('.modal.kb-v3-dialog'));
		const signature=createHash('sha256').update(await readFile(join(fixture.vault,'Alpha','kb.toml'))).digest('hex');
		await observe('changed managed-file receipt in the catalog',(id,signature)=>window.app.plugins.getPlugin(id).catalog.some(lib=>lib.location==='Alpha' && lib.signature===signature),pluginId,signature);
		return {updated:'Alpha/Guide.md',preservedLocalEdit:'Alpha/Policy.md',unaffectedInstance:'Beta'};
	});
}
