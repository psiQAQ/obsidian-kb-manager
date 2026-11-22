// Run from the repository root after building the candidate plugin.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {json, launchDesktop, pluginId, prepareRun, trustFixture, until, workspaceScratch} from '../desktop-qa-host.mjs';
import {defaultConfigDir} from '../../src/fs/segments.ts';

const [directory, revision, scope='reliability'] = process.argv.slice(2);
assert(directory && /^[a-f0-9]{7,40}$/u.test(revision ?? ''));
assert(['reliability','move','all'].includes(scope));
const scratch = await workspaceScratch();
const artifact = resolve(directory);
const templater = resolve('references/templates/obsidian-amatzk-template',defaultConfigDir,'plugins/templater-obsidian');
const exe = process.env.KB_QA_OBSIDIAN ?? join(process.env.LOCALAPPDATA,'Programs','Obsidian','Obsidian.exe');
const fixture = await prepareRun(scratch,{label:'workflows', artifact, templater});
const source = 'Sample template';
const slowPid = join(fixture.run,'slow.pid');
const slowRule = "import {writeFileSync} from 'node:fs';\nexport default async function check(){writeFileSync(" +
	JSON.stringify(slowPid) + ",String(process.pid)); await new Promise(resolve=>setTimeout(resolve,8000)); return [];}\n";
const digest = createHash('sha256').update(slowRule).digest('hex');
const templateFiles = {
	'kb-template.json': JSON.stringify({id:'qa-template',version:'1',purpose:'starter',entry:'Home.md',
		...(scope==='all'?{protocolVersion:1,minManagerVersion:'3.4.0',dependencies:[{id:'templater-obsidian',required:true,minVersion:'2.11.1'}],
			managedFiles:['Guide.md','Policy.md']}:{}),
		pageTemplates:['Templates'],text:{'Home.md':['kb_root','kb_name']},
		checks:[{id:'qa-slow',name:'QA timed check',path:'checks/slow.mjs'}]}),
	'Home.md': '# {{kb_name}}\n\n[[{{kb_root}}/Detail|Detail]]\n\n![[{{kb_root}}/pic.svg|150]]\n',
	'Detail.md': '# Detail\n\nOriginal paragraph. ^place\n',
	'Guide.md':'Pack guide v1\n',
	'Policy.md':'Pack policy v1\n',
	'Templates/Note.md': '# {{title}}\n',
	'pic.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>\n',
	'List.base': 'views:\n  - type: table\n    name: Notes\n',
	'Board.canvas': '{"nodes":[{"id":"card","type":"text","x":0,"y":0,"width":160,"height":80,"text":"Card"}],"edges":[]}\n',
	'checks/slow.mjs': slowRule,
};
for (const [path,content] of Object.entries(templateFiles)) {
	const parts=path.split('/');
	await mkdir(join(fixture.vault,source,...parts.slice(0,-1)),{recursive:true});
	await writeFile(join(fixture.vault,source,path),content);
}
await writeFile(join(fixture.run,'isolated.gitconfig'),'[user]\n\tname = Desktop QA\n\temail = qa@example.invalid\n');
const evidence={revision,scope,run:fixture.run,results:{}};
let desktop;
const evaluate=(fn,...args)=>desktop.evaluate(fn,...args);
async function observe(label,fn,...args) { return until(()=>evaluate(fn,...args),label,20000); }
async function clickText(scopeSelector,label) {
	await observe(label,(selector,label)=>{
		const button=[...document.querySelectorAll(selector)].find(el=>el.checkVisibility() && !el.disabled && el.textContent.trim()===label);
		if(button){button.click();return true;}
	},scopeSelector,label);
}
const modalButton=label=>clickText('.modal button',label);
async function command(id) {
	assert(await evaluate(id=>window.app.commands.executeCommandById(id),pluginId+':'+id));
}
async function newInstance(name) {
	await command('open-manager');
	await clickText('.kb-manager-sidebar button','Create');
	await observe('personal template list',()=>{
		const field=document.querySelector('.kb-create-wizard select');
		if(!field){
			const notice=document.querySelector('.notice')?.innerText;
			if(notice && /Error|failed|not found|invalid/iu.test(notice))throw Error(notice);
			return;
		}
		field.value='@personal';field.dispatchEvent(new Event('change',{bubbles:true}));return true;
	});
	await observe('sample template card',source=>{
		const card=[...document.querySelectorAll('[data-template-source]')].find(el=>el.dataset.templateSource===source);
		if(card){card.click();return true;}
	},source);
	await modalButton('Enter library details');
	await observe('new library parent selector',()=>{
		const field=document.querySelector('.kb-create-wizard .kb-path-field-compact input');
		if(field){field.click();return true;}
	});
	await modalButton('Select Vault root');
	await observe('parent selector applied',()=>!document.querySelector('.kb-path-picker') && !!document.querySelector('.kb-create-wizard .kb-path-field-compact input')?.value);
	await evaluate(name=>{
		const field=document.querySelector('.kb-create-wizard input[placeholder="research-notes"]');
		field.value=name;field.dispatchEvent(new Event('input',{bubbles:true}));
	},name);
	await modalButton('Preview');
	await modalButton('Create library');
	await modalButton('Done');
	await observe('indexed instance',name=>window.app.vault.getFileByPath(name+'/Home.md')?.path,name);
}
async function libraryMenu(name,action) {
	await command('open-manager');
	await observe('library actions '+name,name=>{
		const row=[...document.querySelectorAll('.kb-manager-sidebar .setting-item')].find(row=>row.querySelector('.setting-item-name')?.textContent.trim()===name);
		const button=row?.querySelector('[aria-label="Library actions"]');
		if(button){button.click();return true;}
	},name);
	await clickText('.menu .menu-item',action);
}
async function gitFocus() {
	await desktop.call('Page.bringToFront');
	await evaluate(()=>{window.focus();window.dispatchEvent(new Event('focus'));});
}
function gitAt(location,...args) {
	return execFileSync('git',['-C',join(fixture.vault,location),...args],{encoding:'utf8',windowsHide:true,
		env:{...process.env,GIT_CONFIG_GLOBAL:join(fixture.run,'isolated.gitconfig'),GIT_CONFIG_NOSYSTEM:'1'}}).trim();
}
async function scenario(name,run) {
	try {const details=await run();evidence.results[name]={status:'Passed',details};}
	catch(error){
		evidence.results[name]={status:'Failed',error:String(error),ui:await evaluate(()=>({
			modals:[...document.querySelectorAll('.modal')].map(el=>el.innerText.slice(-1400)),
			notices:window.kbQANotices,
			panel:document.querySelector('.kb-manager-sidebar')?.innerText.slice(-1200),
			catalog:window.app.plugins.getPlugin('knowledge-base-manager')?.catalog.map(lib=>[lib.location,lib.signature,lib.problem]),
			views:window.app.workspace.getLeavesOfType('knowledge-base-manager-view').map(leaf=>({
				current:leaf.view.plugin===window.app.plugins.getPlugin('knowledge-base-manager'),
				catalog:leaf.view.plugin?.catalog.map(lib=>[lib.location,lib.signature]),
			})),
		})).catch(()=>null)};
		throw error;
	}finally{await json(join(fixture.run,'workflows.json'),evidence);}
}
async function runTimedCheck(how) {
	await libraryMenu('Alpha','Check library');
	await observe('timed check selection',()=>{
		const modal=document.querySelector('.modal.kb-v3-health'),select=modal?.querySelector('select');
		if(!select)return;
		select.value='custom';select.dispatchEvent(new Event('change',{bubbles:true}));
		const rows=[...modal.querySelectorAll('.kb-v3-check-choice')];
		const timed=rows.find(row=>row.innerText.includes('QA timed check'));
		if(!timed)return;
		rows.find(row=>row.innerText.includes('Manifest and registration')).querySelector('input').click();
		timed.querySelector('input').click();return true;
	});
	const old=await readFile(slowPid,'utf8').catch(()=>'');
	await modalButton('Start check');
	const pid=await until(async()=>{const s=await readFile(slowPid,'utf8').catch(()=>'');return s && s!==old && Number(s);},'checker child PID');
	if(how==='button')await modalButton('Cancel check');
	else if(how==='close')await evaluate(()=>document.querySelector('.modal.kb-v3-health :is(.modal-header-button,.modal-close-button)').click());
	else await evaluate(id=>window.app.plugins.disablePlugin(id),pluginId);
	await until(()=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'checker exit');
	if(how==='button'){
		await observe('completed and unrun checks in cancelled report',()=>{
			const text=document.querySelector('.kb-v3-check-output')?.innerText;
			return text?.includes('Cancelled') && text.includes('Not run') && text.includes('Passed');
		});
		await evaluate(()=>document.querySelector('.modal.kb-v3-health :is(.modal-header-button,.modal-close-button)').click());
	}
	if(how==='unload'){
		await evaluate(id=>window.app.plugins.enablePlugin(id),pluginId);
		await observe('plugin enabled again',id=>!!window.app.commands.commands[id+':open-manager'],pluginId);
	}
	return pid;
}

try {
	desktop=await launchDesktop(fixture,exe);
	await trustFixture(desktop);
	await observe('trusted startup finished',id=>window.app.workspace.layoutReady && !!window.app.commands.commands[id+':open-manager'] && !!window.app.plugins.getPlugin('templater-obsidian'),pluginId);
	await desktop.close();
	desktop=await launchDesktop(fixture,exe,'trusted');
	await trustFixture(desktop);
	await observe('registered manager command and ready workspace',id=>window.app.workspace.layoutReady && !!window.app.commands.commands[id+':open-manager'],pluginId);
	await observe('Templater 2.11.1 to finish loading',()=>window.app.plugins.getPlugin('templater-obsidian')?.manifest.version);
	evidence.host=await evaluate(id=>({obsidian:window.require('electron').ipcRenderer.sendSync('version'),
		plugin:window.app.plugins.getPlugin(id).manifest.version,templater:window.app.plugins.getPlugin('templater-obsidian')?.manifest.version}),pluginId);
	assert.equal(evidence.host.templater,'2.11.1');
	await evaluate(async(id,source,digest)=>{
		const plugin=window.app.plugins.getPlugin(id);
		plugin.config.templates=[source];await plugin.persist();
		window.app.saveLocalStorage(id+':check-script-trust',[digest]);
		window.kbQANotices=[];
		new MutationObserver(()=>{
			for(const el of document.querySelectorAll('.notice'))if(el.innerText && !window.kbQANotices.includes(el.innerText))window.kbQANotices.push(el.innerText);
		}).observe(document.body,{subtree:true,childList:true});
	},pluginId,source,digest);
	await scenario('twoInstancesWithTemplater',async()=>{
		for(const name of ['Alpha','Beta'])await newInstance(name);
		const targets={};
		for(const name of ['Alpha','Beta']){
			targets[name]=await observe('resolved home links',name=>{
				const from=name+'/Home.md',meta=window.app.metadataCache.getFileCache(window.app.vault.getFileByPath(from));
				if(!meta?.links?.length || !meta.embeds?.length)return;
				const lookup=link=>window.app.metadataCache.getFirstLinkpathDest(link.link,from)?.path;
				return [lookup(meta.links[0]),lookup(meta.embeds[0])];
			},name);
			assert.deepEqual(targets[name],[name+'/Detail.md',name+'/pic.svg']);
			for(const path of ['List.base','Board.canvas'])assert.equal(await readFile(join(fixture.vault,name,path),'utf8'),templateFiles[path]);
			assert.equal(gitAt(name,'status','--porcelain'), '');
		}
		return targets;
	});
	await scenario('externalSettings',async()=>{
		const path=join(fixture.installed,'data.json');
		const shared=JSON.parse(await readFile(path,'utf8'));
		await json(path,{...shared,language:'zh',defaults:{...shared.defaults,hunkSigns:true,refreshSourceControlTimer:500},extraQA:'keep'});
		await observe('host reload of synced settings',id=>window.app.plugins.getPlugin(id).prefs.language==='zh' &&
			window.app.commands.commands[id+':open-manager']?.name.includes('知识库'),pluginId);
		await evaluate(id=>window.app.plugins.getPlugin(id).persist(),pluginId);
		assert.equal(JSON.parse(await readFile(path,'utf8')).extraQA,'keep');
		shared.language='en';shared.defaults={...shared.defaults,hunkSigns:true,refreshSourceControlTimer:500};
		await json(path,shared);
		await observe('English commands restored',id=>window.app.plugins.getPlugin(id).prefs.language==='en',pluginId);
		const manifest=join(fixture.vault,'Beta','kb.toml'),before=await readFile(manifest,'utf8');
		const edited=before.replace(/displayName\s*=\s*"Beta"/u,'displayName = "Synced Beta"');
		assert.notEqual(edited,before);
		const showsName=name=>observe('updated manifest row '+name,name=>[...document.querySelectorAll('.kb-manager-sidebar .setting-item-name')].some(el=>el.textContent===name),name);
		await writeFile(manifest,edited);await showsName('Synced Beta');
		await writeFile(manifest,before);await showsName('Beta');
		return {languageTransition:['en','zh','en'],preservedUnknownField:true,manifestRow:['Beta','Synced Beta','Beta']};
	});
	await scenario('externalGit',async()=>{
		await command('open-manager');
		await observe('open Alpha Git panel',()=>{
			const row=[...document.querySelectorAll('.kb-library-row')].find(row=>row.querySelector('.setting-item-name')?.textContent.trim()==='Alpha');
			const expand=row?.querySelector('[aria-expanded]');
			if(!expand)return;
			if(expand.getAttribute('aria-expanded')==='false')expand.click();return true;
		});
		await observe('commit input',()=>!!document.querySelector('.kb-workspace-commit textarea'));
		await evaluate(async()=>{
			const file=window.app.vault.getFileByPath('Alpha/Detail.md');
			await window.app.workspace.getLeaf(false).openFile(file,{state:{mode:'source'}});
			await window.app.vault.process(file,text=>text+'\nNew paragraph.\n');
		});
		await observe('editor gutter before staging',()=>/[^ \n\t]/u.test(document.querySelector('.kb-hunk-gutter')?.textContent??''));
		await observe('editable commit draft',()=>{
			const box=document.querySelector('.kb-workspace-commit textarea');
			if(!box)return;
			box.value='draft keeps its selection';box.dispatchEvent(new Event('input',{bubbles:true}));box.focus();box.setSelectionRange(2,8);
			return true;
		});
		gitAt('Alpha','add','--','Detail.md');
		await gitFocus();
		await observe('externally staged file and refreshed editor baseline',()=>{
			const row=document.querySelector('.kb-workspace-file[data-path="Detail.md"]');
			return row?.querySelector('[aria-label^="Unstage"]') && !document.querySelector('.kb-hunk-gutter')?.textContent.trim();
		});
		const selection=await evaluate(()=>{const b=document.querySelector('.kb-workspace-commit textarea');return [b.value,b.selectionStart,b.selectionEnd];});
		assert.deepEqual(selection,['draft keeps its selection',2,8]);
		await clickText('.kb-manager-sidebar button','History');
		await observe('open commit graph',()=>!!document.querySelector('.kb-history-subject'));
		gitAt('Alpha','commit','-m','External workflow test');const head=gitAt('Alpha','rev-parse','HEAD');
		await gitFocus();
		await observe('current HEAD on panel',head=>document.querySelector('.kb-workspace-meta')?.textContent.includes(head.slice(0,10)),head);
		await observe('external commit in the open graph',()=>[...document.querySelectorAll('.kb-history-subject')].some(el=>el.textContent==='External workflow test'));
		return {head,selection,openHistoryUpdated:true};
	});
	await scenario('diagnosticLifecycle',async()=>{
		const path=join(fixture.vault,'Alpha','.log');
		const before=await readdir(path);
		const pids={};
		for(const how of ['button','close','unload'])pids[how]=await runTimedCheck(how);
		assert.deepEqual(await readdir(path),before);
		assert.equal(await evaluate(()=>!!document.querySelector('.modal.kb-v3-health')),false);
		return {terminated:pids,historyFiles:before.length};
	});
	if(scope==='all'){
		await scenario('fieldEditActions',async()=>{
			const manifest=join(fixture.vault,'Alpha','kb.toml'),before=await readFile(manifest,'utf8');
			const draft='Desktop preview\nSecond line';
			const editDescription=async value=>{
				await libraryMenu('Alpha','Edit');
				return observe('description field',value=>{
					const input=document.querySelector('.kb-dialog textarea[aria-label="Description"]');
					if(!input)return;
					const previous=input.value;
					input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
					return {previous};
				},value);
			};
			const {previous}=await editDescription(draft);
			await modalButton('Preview changes');
			const values=await observe('description comparison',()=>{
				const pair=document.querySelector('.kb-change-pair');
				if(pair)return [...pair.querySelectorAll('dd')].map(cell=>cell.textContent);
			});
			assert.equal(values.length,2);assert.equal(values[1],draft);
			assert.equal(await readFile(manifest,'utf8'),before);
			await modalButton('Apply changes');
			await observe('preview saved',()=>!document.querySelector('.kb-dialog'));
			assert.notEqual(await readFile(manifest,'utf8'),before);
			await editDescription(previous);
			await modalButton('Apply directly');
			await observe('direct save complete',()=>!document.querySelector('.kb-dialog'));
			assert.equal(await readFile(manifest,'utf8'),before);
			return {previewReadOnly:true,multilinePreserved:true,originalRestored:true};
		});
		const {verifyDiagnosticHistory}=await import('./diagnostic-history.mjs');
		await verifyDiagnosticHistory({fixture,scenario,observe,modalButton,libraryMenu,evaluate});
		const {verifyTemplateUpdate}=await import('./template-update.mjs');
		await verifyTemplateUpdate({fixture,scenario,observe,modalButton,libraryMenu,evaluate,source});
	}
	if(scope!=='reliability'){
		const {verifyMoveAndLayout}=await import('./move-and-layout.mjs');
		await verifyMoveAndLayout({desktop,fixture,scenario,command,observe,modalButton,libraryMenu,evaluate});
	}
} catch(error) {
	evidence.error=String(error);
	evidence.rendererErrors=desktop?.errors;
	console.error(error);process.exitCode=1;
} finally {
	await desktop?.close();
	await json(join(fixture.run,'workflows.json'),evidence);
	process.stdout.write(fixture.run+' '+JSON.stringify(evidence.results)+'\n');
}
