import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {managerType, pluginId} from '../desktop-qa-host.mjs';

export async function verifyMoveAndLayout({fixture,scenario,command,observe,modalButton,libraryMenu,evaluate}) {
	await scenario('moveWhileEditing',async()=>{
		const untouched='[[Alpha/Detail#Detail|leave this file alone]]\n';
		const baseFilters='filters:\n  and:\n    - file.inFolder("Alpha/Notes")\n    - file.path.startsWith("Alpha/Other/")\nviews:\n  - type: table\n    name: Personal\n';
		const embeddedBase='[[Alpha/Detail#Detail|section]]\n\n```base\n'+baseFilters+'```\n';
		const sources={
			'Alpha/Inside.md':'[[Alpha/Detail#Detail|section]]\n',
			'Alpha/Relative.md':'---\nsource: "[[./Detail]]"\n---\n\n[[./Detail]]\n',
			'Beta/References.md':'[[Alpha/Detail#^place|paragraph]]\n![[Alpha/pic.svg|40]]\n[details](../Alpha/Detail.md#Detail)\n',
			'Beta/Links.canvas':'{"nodes":[{"id":"a","type":"file","file":"Alpha/Detail.md","x":0,"y":0,"width":200,"height":80}],"edges":[]}\n',
			'Keep.md':untouched,
			'Alpha/Personal.base':baseFilters,
			'Alpha/Embedded.md':embeddedBase,
			'Same name.md':'[[Detail|ambiguous short name]]\n',
		};
		await evaluate(async sources=>{
			window.app.vault.setConfig('alwaysUpdateLinks',true);
			for(const [name,body] of Object.entries(sources))await window.app.vault.create(name,body);
			const leaf=window.app.workspace.getLeaf('tab');
			await leaf.openFile(window.app.vault.getFileByPath('Alpha/Detail.md'),{state:{mode:'source'}});
			leaf.view.editor.setCursor({line:2,ch:5});
			window.kbQAMovingLeaf=leaf;
		},sources);
		await observe('indexed references in each ownership group',()=>['Alpha/Inside.md','Beta/References.md','Keep.md']
			.every(file=>window.app.metadataCache.resolvedLinks[file]?.['Alpha/Detail.md']));
		await libraryMenu('Alpha','Move');
		await modalButton('Browse…');
		await modalButton('Select Vault root');
		await observe('move parent selector applied',()=>!document.querySelector('.kb-path-picker'));
		await evaluate(()=>{
			const modal=[...document.querySelectorAll('.modal')].at(-1);
			const input=[...modal.querySelectorAll('.setting-item')].find(row=>row.textContent.includes('Destination folder name')).querySelector('input');
			input.value='Renamed';input.dispatchEvent(new Event('input',{bubbles:true}));
		});
		await modalButton('Preview directory move');
		const groups=await observe('reference group choices',()=>{
			const controls=[...document.querySelectorAll('.kb-move-reference-group input')];
			if(controls.length<3)return;
			return Object.fromEntries(controls.map(el=>[el.getAttribute('aria-label'),el.checked]));
		});
		assert.deepEqual(groups,{Alpha:true,Beta:false,'Unregistered Vault files':false});
		assert(await evaluate(()=>{
			const dialog=[...document.querySelectorAll('.modal')].at(-1);
			return !dialog.querySelector('[data-move-reference-section="preserved"]') && !dialog.textContent.includes('Alpha/Relative.md');
		}));
		assert(await evaluate(()=>[...document.querySelectorAll('.modal details li')].some(el=>el.textContent.includes('Same name.md') && el.textContent.includes('ambiguous wikilink'))));
		await evaluate(()=>document.querySelector('.kb-move-reference-group input[aria-label="Beta"]').click());
		const selectedFields=await evaluate(()=>{
			const fields=[...document.querySelectorAll('input[data-base-file]')];
			const selections=fields.filter(input=>input.dataset.basePath==='Alpha/Notes');
			const initial=fields.map(input=>input.checked);
			for(const input of selections){
				const section=input.closest('details');
				if(section && !section.open)section.querySelector('summary').click();
				if(!input.checkVisibility())throw new Error('Base path choice is not visible in the expanded section');
				input.click();
			}
			return {initial,files:selections.map(input=>input.dataset.baseFile).sort()};
		});
		assert.deepEqual(selectedFields.initial,[false,false,false,false]);
		assert.deepEqual(selectedFields.files,['Alpha/Embedded.md','Alpha/Personal.base']);
		await modalButton('Move entire directory');
		const moveState=id=>{
			const plugin=window.app.plugins.getPlugin(id);
			if(plugin.catalog.some(lib=>lib.location==='Renamed') && !plugin.catalog.some(lib=>lib.location==='Alpha'))return 'complete';
			const renameBlocked=window.kbQANotices.some(message=>/\b(?:EBUSY|EPERM):[^\n]*\brename\b/u.test(message));
			if(renameBlocked && document.querySelector('.kb-manager-sidebar')?.innerText.includes('Review and continue'))return 'busy';
		};
		const first=await observe('move result or Windows file lock',moveState,pluginId);
		if(first==='busy'){
			await observe('review the saved move',()=>{
				const button=[...document.querySelectorAll('.kb-manager-sidebar button')].find(el=>el.textContent==='Review and continue');
				if(button){button.click();return true;}
			});
			await modalButton('Resume move');
			await observe('completed move after resuming the saved record',id=>window.app.plugins.getPlugin(id).catalog.some(lib=>lib.location==='Renamed'),pluginId);
		}
		const read=path=>readFile(join(fixture.vault,path),'utf8');
		assert.equal(await read('Keep.md'),untouched);
		assert.equal(await read('Same name.md'),sources['Same name.md']);
		assert.equal(await read('Beta/References.md'),sources['Beta/References.md'].replaceAll('Alpha/','Renamed/'));
		assert.equal(await read('Beta/Links.canvas'),sources['Beta/Links.canvas'].replace('Alpha/','Renamed/'));
		assert.equal(await read('Renamed/Inside.md'),sources['Alpha/Inside.md'].replace('Alpha/','Renamed/'));
		assert.equal(await read('Renamed/Relative.md'),sources['Alpha/Relative.md']);
		assert.equal(await read('Renamed/Personal.base'),baseFilters.replace('Alpha/Notes','Renamed/Notes'));
		assert.equal(await read('Renamed/Embedded.md'),embeddedBase.replace('Alpha/Notes','Renamed/Notes').replace('Alpha/Detail','Renamed/Detail'));
		await observe('resolved destinations after the rename',()=>{
			const links=window.app.metadataCache.resolvedLinks;
			return links['Renamed/Inside.md']?.['Renamed/Detail.md'] && links['Beta/References.md']?.['Renamed/Detail.md']
				&& links['Beta/References.md']?.['Renamed/pic.svg'];
		});
		const editor=await evaluate(()=>({path:window.kbQAMovingLeaf.view.file?.path,cursor:window.kbQAMovingLeaf.view.editor?.getCursor()}));
		assert.deepEqual(editor,{path:'Renamed/Detail.md',cursor:{line:2,ch:5}});
		return {groups,editor,firstAttempt:first,selected:['Renamed/Inside.md','Beta/References.md','Beta/Links.canvas'],preserved:'Keep.md'};
	});
	await scenario('managerLayout',async()=>{
		await command('open-manager');
		const first=await evaluate(type=>window.app.workspace.getLeavesOfType(type)[0]?.getRoot()===window.app.workspace.rightSplit,managerType);
		assert(first,'First manager opens on the right');
		const samples=[];
		for(const place of ['left','main','popout']){
			await evaluate(async(type,place)=>{
				const ws=window.app.workspace,current=ws.getLeavesOfType(type)[0];
				const state=current.getViewState();
				if(place==='popout')ws.moveLeafToPopout(current);
				else {
					const leaf=place==='left'?ws.getLeftLeaf(true):ws.getLeaf('tab');
					current.detach();await leaf.setViewState(state);await ws.revealLeaf(leaf);
				}
			},managerType,place);
			await observe('manager at '+place,(type,place)=>{
				const ws=window.app.workspace,leaves=ws.getLeavesOfType(type);
				const leaf=leaves[0];if(leaves.length!==1 || !leaf?.view.contentEl)return;
				return place==='left'?leaf.getRoot()===ws.leftSplit:place==='main'?leaf.getRoot()===ws.rootSplit:leaf.view.contentEl.win!==window;
			},managerType,place);
			const restored=await evaluate(async(id,type)=>{
				const plugin=window.app.plugins.getPlugin(id),ws=window.app.workspace;
				const existing=ws.getLeavesOfType(type)[0],view=await plugin.openManager();
				const lib=plugin.catalog.find(lib=>lib.location==='Beta');
				if(!lib)throw Error('Missing Beta in manager catalog');
				await view.showLibrary(lib.identity.id,'remote');
				return {sameLeaf:existing===view.leaf,count:ws.getLeavesOfType(type).length,state:view.leaf.getViewState().state};
			},pluginId,managerType);
			assert(restored.sameLeaf && restored.count===1 && restored.state.expanded);
			assert.equal(restored.state.tabs[restored.state.selected],'remote');
			if(place!=='popout'){
				await evaluate(async()=>{const ws=window.app.workspace;await ws.changeLayout(ws.getLayout());});
				await observe('restored '+place+' panel after layout reload',(type,expected)=>{
					const leaf=window.app.workspace.getLeavesOfType(type)[0],state=leaf?.getViewState().state;
					return state?.selected===expected && state.expanded===true && state.tabs?.[expected]==='remote';
				},managerType,restored.state.selected);
			}
			samples.push({place,...restored});
		}
		const modal=await evaluate(async(id,type)=>{
			const view=await window.app.plugins.getPlugin(id).openManager();await view.create();
			const owner=window.app.workspace.getLeavesOfType(type)[0].view.contentEl.doc;
			return {inManagerWindow:!!owner.querySelector('.kb-create-wizard'),inMain:!!document.querySelector('.kb-create-wizard')};
		},pluginId,managerType);
		assert.deepEqual(modal,{inManagerWindow:true,inMain:false});
		return {defaultLocation:'right',samples,popoutDialog:modal};
	});
}
