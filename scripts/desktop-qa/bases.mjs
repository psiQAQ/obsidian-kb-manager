// Run from the repository root after building the candidate plugin.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parse} from 'smol-toml';
import {json, launchDesktop, pluginId, prepareRun, trustFixture, until, workspaceScratch} from '../desktop-qa-host.mjs';

const [directory, revision] = process.argv.slice(2);
assert(directory && /^[a-f0-9]{7,40}$/u.test(revision ?? ''), 'Pass the build directory and its source revision');
const executable = process.env.KB_QA_OBSIDIAN ?? join(process.env.LOCALAPPDATA,'Programs','Obsidian','Obsidian.exe');
const fixture = await prepareRun(await workspaceScratch(), {label:'bases-move', artifact:resolve(directory)});
const evidence = {revision, run:fixture.run, stages:{},
	artifactSha256:createHash('sha256').update(await readFile(join(fixture.installed,'main.js'))).digest('hex')};
const receipt = join(fixture.run, 'bases.json');
process.stdout.write('Bases desktop QA: '+fixture.run+'\n');
await Promise.all(['Before','After','Peer','Peer/wiki','Peer/Notes','Peer/References'].map(
	path => mkdir(join(fixture.vault,path), {recursive:true})));
await writeFile(join(fixture.run,'isolated.gitconfig'),'[user]\n\tname = Bases QA\n\temail = qa@example.invalid\n');
await json(join(fixture.config,'types.json'), {types:{last:'date', updated:'date', archived:'date'}});

let desktop;
const observe = (label,fn,...args) => until(() => desktop.evaluate(fn,...args),label,20000);
async function command(name) {
	assert(await desktop.evaluate(id => window.app.commands.executeCommandById(id), pluginId+':'+name));
}
const click = (label,selector='.modal button') => observe(label,(label,selector)=>{
	const control=[...document.querySelectorAll(selector)].find(el=>el.checkVisibility()&&!el.disabled&&el.textContent.trim()===label);
	if (control) { control.click(); return true; }
	const error=[...document.querySelectorAll('.modal .kb-action-error')].find(el=>el.checkVisibility()&&el.innerText.trim());
	if (error) throw Error(error.innerText);
},label,selector);
const fill = (selector,value,type='input') => observe('field '+selector,(selector,value,type)=>{
	const field=document.querySelector(selector);
	if (!field?.checkVisibility()) return;
	field.value=value;
	field.dispatchEvent(new Event(type,{bubbles:true}));
	return true;
},selector,value,type);
async function parentFolder(parent) {
	await click('Enter path','.kb-path-picker [role=tab]');
	await fill('.kb-path-picker input[aria-label="Vault-relative folder path"]',parent);
	await click('Use entered path');
	await observe('parent folder applied',()=>!document.querySelector('.kb-path-picker'));
}
async function create(id,purpose,source) {
	await command('open-manager');
	await click('Create','.kb-manager-sidebar button');
	await fill('.kb-create-wizard select[aria-label="Use case"]',purpose,'change');
	await observe('template '+id,source=>{
		const card=[...document.querySelectorAll('.kb-v3-template-card')].find(el=>el.dataset.templateSource===source);
		if (card) { card.click(); return true; }
	},source);
	await click('Enter library details');
	await observe('creation parent picker',()=>{
		const field=document.querySelector('.kb-create-wizard .kb-path-field-compact input');
		if (field) { field.click(); return true; }
	});
	await parentFolder('Before');
	await fill('.kb-create-wizard input[placeholder="research-notes"]',id);
	await click('Preview');
	await click('Create library');
	await click('Done');
	return parse(await readFile(join(fixture.vault,'Before',id,'kb.toml'),'utf8')).manager;
}

async function move(id,bindingPath) {
	const from='Before/'+id, to='After/'+id;
	await command('open-manager');
	await observe('library actions '+id,id=>{
		const row=[...document.querySelectorAll('.kb-manager-sidebar .setting-item')]
			.find(row=>row.querySelector('.setting-item-name')?.textContent.trim()===id);
		const button=row?.querySelector('button[aria-label="Move"]');
		if (button) { button.click(); return true; }
	},id);
	await click('Browse…');
	await parentFolder('After');
	await click('Preview directory move');
	await observe('move preview includes the Base binding',path=>{
		const title=[...document.querySelectorAll('.modal-title')].find(el=>el.textContent==='Review directory move');
		return title?.closest('.modal').textContent.includes(path);
	},bindingPath);
	const noticeStart=await desktop.evaluate(()=>window.basesQaNotices.length);
	await click('Move entire directory');
	const waitForMove=(noticeStart)=>observe('move to '+to,(from,to,id,noticeStart)=>{
		const files=window.app.vault, registered=window.app.plugins.getPlugin(id).catalog;
		if (files.getFolderByPath(to) && !files.getFolderByPath(from) &&
			registered.some(lib=>lib.location===to) && !registered.some(lib=>lib.location===from)) return 'complete';
		if (window.basesQaNotices.slice(noticeStart).some(message=>/\b(?:EBUSY|EPERM):[^\n]*\brename\b/u.test(message)) &&
			document.querySelector('.kb-manager-sidebar')?.innerText.includes('Review and continue')) return 'busy';
	},from,to,pluginId,noticeStart);
	const firstAttempt=await waitForMove(noticeStart);
	if (firstAttempt==='busy') {
		await click('Review and continue','.kb-manager-sidebar button');
		await click('Resume move');
		assert.equal(await waitForMove(await desktop.evaluate(()=>window.basesQaNotices.length)),'complete');
	}
	await desktop.evaluate(()=>{
		const close=[...document.querySelectorAll('.modal')].at(-1)?.querySelector('.modal-close-button');
		close?.click();
	});
	assert.equal(await stat(join(fixture.vault,to)).then(s=>s.isDirectory()),true);
	await assert.rejects(stat(join(fixture.vault,from)),{code:'ENOENT'});
	const manifest=parse(await readFile(join(fixture.vault,to,'kb.toml'),'utf8')).manager;
	return {from,to,firstAttempt,id:manifest.id,version:manifest.template.version};
}

const markdown = properties => '---\n'+Object.entries(properties)
	.map(([key,value]) => key+': '+JSON.stringify(value)).join('\n')+'\n---\n\nSynthetic Bases desktop QA record.\n';
const showsBase = 'Templates/Bases/Shows.base';
const showPath = day => 'References/Episode '+String(day*17%29).padStart(2,'0')+'.md';
const dates = Array.from({length:23},(_,index)=>index+1);
const targetShows = [...dates].reverse().slice(0,20).map(showPath);
const allShows = [...dates.map(showPath),'References/Futurama.md'];
const peerShow = 'Peer/'+showPath(dates.at(-1));
const outsideShow = parent => markdown({categories:[`[[../../${parent}/kepano/Categories/Shows]]`],last:'2026-02-03'});
const show = {'categories':['[[../Categories/Shows]]']};
const agent = {type:'concept',managed_by:'agent',updated:'2026-01-10',categories:['QA topic']};
const archive = {type:'archive',managed_by:'agent',archived:'2026-01-09'};
const human = {type:'note',managed_by:'human',created:'2026-01-08'};
const wikiViews = {
	'现行知识':['wiki/Concept positive.md'],
	'人工笔记':['Notes/Human positive.md'],
	'按类别浏览':['wiki/Concept positive.md'],
	'历史归档':['wiki/Archive positive.md'],
};
const wikiHost = 'Wiki dashboard.md';
const embed = base => '![['+base+'#现行知识]]\n';
async function seed() {
	const contents = {
		...Object.fromEntries(dates.map(day=>['Before/kepano/'+showPath(day),
			markdown({...show,last:'2026-01-'+String(day).padStart(2,'0')})])),
		'Before/kepano/References/Missing last.md':markdown(show),
		'Before/kepano/References/Null last.md':markdown({...show,last:null}),
		'Before/kepano/References/Empty last.md':markdown({...show,last:''}),
		'Before/kepano/References/Uncategorized.md':markdown({last:'2026-02-01'}),
		'Before/kepano/References/Show Template QA.md':markdown({...show,last:'2026-02-02'}),
		[peerShow]:outsideShow('Before'),
		'Before/llm-wiki/wiki/Concept positive.md':markdown(agent),
		'Before/llm-wiki/wiki/Archive positive.md':markdown(archive),
		'Before/llm-wiki/wiki/Empty concept.md':markdown({...agent,status:'empty'}),
		'Before/llm-wiki/wiki/Human concept.md':markdown({...agent,managed_by:'human'}),
		'Before/llm-wiki/wiki/Missing type.md':markdown({managed_by:'agent'}),
		'Before/llm-wiki/wiki/Human archive.md':markdown({...archive,managed_by:'human'}),
		'Before/llm-wiki/Notes/Human positive.md':markdown(human),
		'Before/llm-wiki/raw/Misplaced concept.md':markdown(agent),
		['Before/llm-wiki/'+wikiHost]:embed('./knowledge.base'),
		'Peer/wiki/Concept positive.md':markdown(agent),
		'Peer/wiki/Archive positive.md':markdown(archive),
		'Peer/Notes/Human positive.md':markdown(human),
		['Peer/'+wikiHost]:embed('../Before/llm-wiki/knowledge.base'),
	};
	await desktop.evaluate(async contents=>{
		const {vault}=window.app;
		for (const [path,text] of Object.entries(contents)) {
			const folder=path.slice(0,path.lastIndexOf('/'));
			if (!vault.getFolderByPath(folder)) await vault.createFolder(folder);
			await vault.create(path,text);
		}
	},contents);
	return Object.keys(contents);
}

// Run in the verified Obsidian renderer and read complete native results, including rows outside the display limit.
async function readViews(path,names,host) {
	const {workspace,vault}=window.app;
	const previous=workspace.activeLeaf;
	const temporary=workspace.getLeaf('split');
	if (temporary===previous) throw Error('The test leaf was not isolated');
	const wait = async (read,label)=>{
		const deadline=Date.now()+8000;
		do {
			const result=read();
			if (result) return result;
			await new Promise(resolve=>window.setTimeout(resolve,25));
		} while(Date.now()<deadline);
		throw Error('Missing native Bases result: '+label);
	};
	const noticeStart=window.basesQaNotices.length;
	try {
		await temporary.openFile(vault.getFileByPath(host ?? path),host ? {active:true,state:{mode:'preview',source:false}} : {active:true});
		await workspace.revealLeaf(temporary);
		const native=temporary.view;
		const controller=host ? await wait(()=>{
			const stack=[...native.previewMode._children];
			while (stack.length) {
				const component=stack.pop();
				if (component.file?.path===path && native.contentEl.contains(component.containerEl))
					return component.controller;
				stack.push(...(component._children ?? []));
			}
		},path) : native.controller;
		if (native.file?.path!==(host ?? path) || !controller) throw Error('Wrong Bases file or host: '+path);
		const views={};
		for (const name of names) {
			const old=controller.view?.data, changed=controller.viewName!==name;
			if (!host) controller.selectView(name);
			views[name]=await wait(()=>{
				if (controller.error) throw Error(controller.errorEl.textContent.trim());
				const view=controller.view, container=controller.viewContainerEl;
				if (controller.query?.file?.path!==path || container.dataset.viewName!==name || view?.config.name!==name
					|| !Array.isArray(view.data?.data) || controller.initialScan || (changed&&view.data===old)) return;
				return {
					shown:view.data.data.map(row=>row.file.path),
					matching:[...controller.results.keys()].map(file=>file.path).sort(),
					context:controller.getCurrentFile()?.path,
					resultCount:controller.resultsMenu.resultCount,
					shownCount:controller.resultsMenu.shownCount,
					visible:container.checkVisibility(),
				};
			},name);
		}
		return {path,host,views,notices:window.basesQaNotices.slice(noticeStart)};
	} finally {
		temporary.detach();
		if (previous && workspace.isAttached(previous)) workspace.setActiveLeaf(previous);
	}
}

function assertView(read,name,expected,all=expected) {
	const actual=read.views[name];
	assert.equal(actual.context,read.host ?? read.path,name);
	assert.equal(actual.visible,true,name);
	assert.equal(actual.shownCount,expected.length,name);
	assert.equal(actual.resultCount,all.length,name);
	assert.deepEqual(actual.shown,expected,name+' visible and ordered');
	assert.deepEqual(actual.matching,[...all].sort(),name+' all matches');
}
async function verify(parent,paths) {
	const kepano=parent+'/kepano/', wiki=parent+'/llm-wiki/';
	await observe('stable file metadata in '+parent,paths=>paths.every(path=>{
		const file=window.app.vault.getFileByPath(path);
		return file && window.app.metadataCache.getFileCache(file);
	}),paths);
	const peerCategory=await observe('the outside show still resolves the tested library category',(notePath,category)=>{
		const {vault,metadataCache}=window.app;
		const file=vault.getFileByPath(notePath);
		const refs=metadataCache.getFileCache(file)?.frontmatterLinks ?? [];
		const resolved=refs.map(ref=>metadataCache.getFirstLinkpathDest(ref.link,notePath)?.path);
		return resolved.includes(category) ? category : null;
	},peerShow,kepano+'Categories/Shows.md');
	const shows=await desktop.evaluate(readViews,kepano+showsBase,['Last seen']);
	const overview=await desktop.evaluate(readViews,wiki+'knowledge.base',Object.keys(wikiViews));
	const ownHost=await desktop.evaluate(readViews,wiki+'knowledge.base',['现行知识'],wiki+wikiHost);
	const peerHost=await desktop.evaluate(readViews,wiki+'knowledge.base',['现行知识'],'Peer/'+wikiHost);
	const manager=parse(await readFile(join(fixture.vault,kepano,'kb.toml'),'utf8')).manager;
	const binding=manager.managed.find(entry=>entry.path===showsBase);
	const content=await readFile(join(fixture.vault,kepano,showsBase));
	const showsFingerprint=createHash('sha256').update(content).digest('hex');
	evidence.stages[parent]={shows,overview,ownHost,peerHost,peerShow,peerCategory,binding,showsFingerprint};
	await json(receipt,evidence);
	assert.equal(binding?.root,kepano.slice(0,-1),'Shows binding root');
	assert.equal(binding.fingerprint,showsFingerprint,'Native opening must preserve the managed Shows file');
	assertView(shows,'Last seen',targetShows.map(path=>kepano+path),allShows.map(path=>kepano+path));
	for (const [name,matches] of Object.entries(wikiViews)) assertView(overview,name,matches.map(path=>wiki+path));
	assertView(ownHost,'现行知识',wikiViews['现行知识'].map(path=>wiki+path));
	assertView(peerHost,'现行知识',[]);
	const notices=[shows,overview,ownHost,peerHost].flatMap(probe=>probe.notices);
	assert.deepEqual(notices,[],'Native Bases warnings');
	evidence.stages[parent].status='Passed';
	await json(receipt,evidence);
}

try {
	desktop=await launchDesktop(fixture,executable,'bootstrap-process');
	await trustFixture(desktop);
	await desktop.close();
	desktop=undefined;
	desktop=await launchDesktop(fixture,executable);
	await trustFixture(desktop);
	await desktop.call('Page.bringToFront');
	await desktop.call('Emulation.setFocusEmulationEnabled',{enabled:true});
	await desktop.evaluate(()=>{ window.focus(); window.dispatchEvent(new Event('focus')); });
	await observe('layout and active Bases core',()=>window.app.workspace.layoutReady && window.app.internalPlugins.getPluginById('bases')?.enabled);
	evidence.host=await desktop.evaluate(id=>{
		window.basesQaNotices=[];
		new MutationObserver(records=>{
			for (const record of records) for (const node of record.addedNodes) {
				if (!(node instanceof Element)) continue;
				const notices=node.matches('.notice') ? [node] : node.querySelectorAll('.notice');
				for (const notice of notices) window.basesQaNotices.push(notice.textContent.trim());
			}
		}).observe(document.body,{subtree:true,childList:true});
		return {obsidian:window.require('electron').ipcRenderer.sendSync('version'),plugin:window.app.plugins.getPlugin(id).manifest.version};
	},pluginId);
	evidence.created={kepano:await create('kepano','collections','builtin:kepano'), wiki:await create('llm-wiki','ai-workflows','')};
	assert.equal(evidence.created.kepano.template.version,'10');
	const paths=await seed();
	evidence.fixture={paths,targetShows,allShows,wikiViews};
	await verify('Before',paths);
	evidence.moves=[await move('kepano',showsBase),await move('llm-wiki','knowledge.base')];
	assert.deepEqual(evidence.moves.map(result=>result.id),Object.values(evidence.created).map(manager=>manager.id));
	await desktop.evaluate(async ({wikiHost,content,externalShow,externalContent})=>{
		const {vault}=window.app;
		await vault.modify(vault.getFileByPath('Peer/'+wikiHost),content);
		await vault.modify(vault.getFileByPath(externalShow),externalContent);
	},{wikiHost,content:embed('../After/llm-wiki/knowledge.base'),externalShow:peerShow,externalContent:outsideShow('After')});
	await verify('After',paths.map(path=>path.replace(/^Before\//u,'After/')));
	evidence.status='Passed';
} catch (error) {
	evidence.status='Failed';
	evidence.error=error.stack;
	evidence.ui=await desktop?.evaluate(()=>({
		modals:[...document.querySelectorAll('.modal')].map(el=>el.innerText.slice(-3000)),
		notices:window.basesQaNotices, activeFile:window.app.workspace.getActiveFile()?.path,
	})).catch(()=>null);
	throw error;
} finally {
	try { await desktop?.close(); }
	finally { await json(receipt,evidence); }
}
