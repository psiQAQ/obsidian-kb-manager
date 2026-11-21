import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { digest } from '../src/fs/vault.ts';
import { defaults, discover, newIdentity, readManifest, writeIdentity } from '../src/kb/catalog.ts';
import { renderBase } from '../src/kb/template-core.ts';
import { applyIgnoreRule, previewRegistryIgnore, readVaultRegistry, writeVaultRegistry } from '../src/registry/desktop.ts';
import { registerVaultLibrary, scanVaultFolder } from '../src/registry/discovery.ts';
import { confirmImport, previewImport } from '../src/registry/import.ts';
import { amendRegistry, libraryDestination, parseRegistry, registryDataPath, registryIgnoreFor, validateFolderSettings } from '../src/registry/paths.ts';
import { cloneTarget } from '../src/kb/clone.ts';
import { previewCreate } from '../src/kb/create.ts';
import { executeMove, planMove } from '../src/kb/move.ts';

import { withLibraryIgnores } from '../src/kb/identity-core.ts';
import { vaultDisk } from './fixtures/vault-disk.mjs';

const configDir = '.fixture-settings';
const oldRegistryPath = '.kb-manager/libraries.json';

test('adds missing local ignores once and respects later overriding rules', () => {
	const existing='/kb.toml\r\n# local identity\r\n';
	const included=existing+'/.log/\r\n';
	assert.equal(withLibraryIgnores(existing),included);
	assert.equal(withLibraryIgnores(included),included);
	const override=included+'!*\r\n';
	assert.equal(withLibraryIgnores(override),override+'/.log/\r\n/kb.toml\r\n');
});

async function setup(t, settingsDir = configDir) {
	const dir = path.resolve('.tmp');
	await fs.mkdir(dir,{recursive:true});
	const root = await fs.mkdtemp(path.join(dir,'registry-'));
	assert.equal(path.dirname(root),dir);
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk = vaultDisk(root,settingsDir);
	const config = {...defaults,templates:['Templates']};
	const asset = await fs.readFile('assets/templates/ai-workflows/llm-wiki/knowledge.base','utf8');
	const assets = () => ({'knowledge.base':asset});
	const create = async (location, identity=newIdentity(location,'',{id:'llm-wiki',version:'1'}), managed=location) => {
		const folder = await disk.path(location);
		await fs.mkdir(folder,{recursive:true});
		const source = renderBase(asset,managed);
		const next = {...identity,managed:[{path:'knowledge.base',root:managed,fingerprint:digest(source)}]};
		const manifest = writeIdentity('version = 1\n\n# preserve this comment\n[preferences]\nshowFileMenu = false\n',next);
		await fs.writeFile(path.join(folder,'kb.toml'),manifest);
		await fs.writeFile(path.join(folder,'knowledge.base'),source);
		return {identity:next,manifest,source};
	};
	const visible = {
		async replace(relative,before,after) {
			const file = await disk.path(relative);
			assert.equal(digest(await fs.readFile(file)),before);
			await fs.writeFile(file,after);
		},
		async create() { assert.fail('Import creates no content files'); },
	};
	return {root,disk,config,create,assets,visible};
}

test('the Vault registry contains only portable relative paths and reads without writing',async t=>{
	const {root,disk,config,create} = await setup(t);
	const dataFile = path.join(root,registryDataPath(configDir));
	assert.equal(registryDataPath(configDir),`${configDir}/plugins/knowledge-base-manager/data.json`);
	await create('knowledge-base/旧库');
	assert.deepEqual(await discover(disk,config),[]);
	assert.deepEqual(await readVaultRegistry(disk),{raw:null,paths:[]});
	await assert.rejects(fs.stat(dataFile),{code:'ENOENT'});
	for (const invalid of ['{"paths":["Valid"]}','[1]','["C:\\Vault"]','["../Library"]','["/Vault"]','["A","a"]',JSON.stringify([configDir+'/Bad'])]) {
		assert.throws(()=>parseRegistry(invalid,configDir));
	}
	assert.deepEqual(amendRegistry(['Books/One'],{remove:['Books/One'],add:['Books/ONE']},configDir),['Books/ONE']);
	await create('Other/深层/笔记');
	await Promise.all(['knowledge-base/旧库','Other/深层/笔记'].map(location=>registerVaultLibrary(disk,config,location)));
	const raw = await fs.readFile(dataFile,'utf8');
	assert.deepEqual(JSON.parse(raw).registeredLibraries,['Other/深层/笔记','knowledge-base/旧库']);
	await assert.rejects(fs.stat(path.join(root,'.kb-manager')),{code:'ENOENT'});
	assert.equal((await discover(disk,config)).length,2);
});

test('desktop discovery and registration use plugin data and preserve an old registry file',async t=>{
	const {root,disk,config,create} = await setup(t);
	const legacy = path.join(root,oldRegistryPath);
	const dataFile = path.join(root,registryDataPath(configDir));
	const original = '[\r\n  "Old/资料"\r\n]\r\n';
	await create('Old/资料');
	await create('New/资料');
	await fs.mkdir(path.dirname(legacy));
	await fs.writeFile(legacy,original);
	assert.deepEqual(await discover(disk,config),[]);
	await assert.rejects(fs.stat(dataFile),{code:'ENOENT'});
	await registerVaultLibrary(disk,config,'New/资料');
	assert.deepEqual(JSON.parse(await fs.readFile(dataFile,'utf8')).registeredLibraries,['New/资料']);
	assert.deepEqual((await discover(vaultDisk(root,configDir),config)).map(lib=>lib.location),['New/资料']);
	assert.equal(await fs.readFile(legacy,'utf8'),original);
});

test('explicit recursive scans skip templates, configuration, links and nested libraries',async t=>{
	const {root,disk,config,create} = await setup(t);
	await create('Root Library');
	await create('Selected/Group/Actual');
	await create('Selected/Group/Actual/Nested');
	await create('Templates/Unregistered');
	await fs.mkdir(path.join(root,'Selected','Blank'));
	await fs.writeFile(path.join(root,'Selected','Blank','kb.toml'),'version = 1\n');
	await fs.mkdir(path.join(root,configDir,'Fake'),{recursive:true});
	await fs.writeFile(path.join(root,configDir,'Fake','kb.toml'),'version = 1\n');
	await fs.symlink(path.join(root,'Selected','Group','Actual'),path.join(root,'Linked'),'junction');
	const all = await scanVaultFolder(disk,config,'');
	assert.deepEqual(all.libraries.filter(lib=>!lib.problem).map(lib=>lib.location),['Root Library','Selected/Group/Actual']);
	assert.ok(all.libraries.find(lib=>lib.location==='Selected/Blank')?.problem);
	assert.ok(all.skipped.some(item=>item.startsWith('Linked')));
	assert.deepEqual((await scanVaultFolder(disk,config,'Selected')).libraries.filter(lib=>!lib.problem).map(lib=>lib.location),['Selected/Group/Actual']);
	await assert.rejects(scanVaultFolder(disk,config,'Selected/Group/Actual/Nested'));
	assert.equal((await readVaultRegistry(disk)).raw,null);
});

test('location checks allow empty or nested favorites and reserve registered libraries even without a manifest',async t=>{
	const {root,disk,config}=await setup(t);
	assert.deepEqual(defaults.parents,[]);
	assert.doesNotThrow(()=>validateFolderSettings(['Group','Group/Subfolder'],config.templates,disk.configDir));
	assert.throws(()=>validateFolderSettings(['Group','GROUP'],config.templates,disk.configDir));
	assert.equal(libraryDestination('','Root Library'),'Root Library');
	for(const parent of [undefined,null,'/','../Group','D:/External','.git','git~1','Group\\Subfolder'])
		assert.throws(()=>libraryDestination(parent,'New'));
	assert.throws(()=>libraryDestination('','Group/New'));
	const req={name:'New',displayName:'New',description:'',source:'',url:'https://example.invalid/team/library.git'};
	await fs.mkdir(path.join(root,'Occupied'));
	await writeVaultRegistry(disk,null,['Occupied','Stale/Library']);
	await assert.rejects(previewCreate(disk,config,{...req,parent:'Occupied'},{}),/登记|registered/u);
	await assert.rejects(previewCreate(disk,config,{...req,parent:'',name:'Stale'},{}),/登记|registered/u);
	await assert.rejects(cloneTarget(disk,config,{...req,parent:'Occupied'}),/登记|registered/u);
	await assert.rejects(cloneTarget(disk,config,{...req,parent:'Missing'}),/已存在的目录|existing folder/u);
	await assert.rejects(fs.stat(path.join(root,'Missing')),{code:'ENOENT'});
});

test('move rechecks registry reservations before publishing at the Vault root',async t=>{
	const {root,disk,config,create,assets,visible}=await setup(t);
	const source='Category/Original', destination='New Location';
	const {identity}=await create(source);
	await registerVaultLibrary(disk,config,source);
	const [library]=await discover(disk,config);
	const plan=await planMove(disk,config,library,'',destination,assets(library));
	const before=await readVaultRegistry(disk);
	await writeVaultRegistry(disk,before.raw,[...before.paths,destination+'/Stale']);
	let saved;
	const persist=async record=>{saved=record;};
	await assert.rejects(executeMove(disk,config,plan,visible,persist),/登记|registered/u);
	assert.equal(saved,undefined);
	await assert.rejects(fs.stat(path.join(root,destination)),{code:'ENOENT'});
	const conflict=await readVaultRegistry(disk);
	await writeVaultRegistry(disk,conflict.raw,before.paths);
	await executeMove(disk,config,plan,visible,persist);
	assert.equal(saved.phase,'complete');
	assert.deepEqual((await readVaultRegistry(disk)).paths,[destination]);
	assert.equal((await discover(disk,config))[0]?.identity?.id,identity.id);
	assert.deepEqual(config.parents,[]);
});

test('rebind preview checks the fingerprint and confirmation preserves preferences and unrelated bytes',async t=>{
	const {disk,config,create,assets,visible} = await setup(t);
	const {identity,manifest,source} = await create('Here/Imported',undefined,'OldVault/Library');
	const base = await disk.path('Here/Imported/knowledge.base');
	const kb = await disk.path('Here/Imported/kb.toml');
	const plan = await previewImport(disk,config,'Here/Imported',assets);
	assert.equal(plan.rebinding.changes.length,1);
	assert.equal(await fs.readFile(base,'utf8'),source);
	assert.equal(await fs.readFile(kb,'utf8'),manifest);
	assert.equal((await readVaultRegistry(disk)).raw,null);
	await fs.appendFile(base,'# user edit\n');
	await assert.rejects(confirmImport(disk,config,plan,'rebind',assets,visible));
	const edited = await previewImport(disk,config,'Here/Imported',assets);
	assert.equal(edited.rebinding.changes.length,0);
	assert.ok(edited.rebinding.manual.some(text=>text.includes('knowledge.base')));
	assert.equal((await readVaultRegistry(disk)).raw,null);
	await fs.writeFile(base,source);
	await confirmImport(disk,config,plan,'rebind',assets,visible);
	const changed = await fs.readFile(base,'utf8');
	assert.ok(changed.includes('Here/Imported'));
	assert.ok(!changed.includes('OldVault/Library'));
	const text = await fs.readFile(kb,'utf8');
	assert.ok(text.includes('# preserve this comment\n[preferences]\nshowFileMenu = false'));
	const imported = readManifest(text);
	assert.equal(imported.identity.id,identity.id);
	assert.equal(imported.identity.managed[0].root,'Here/Imported');
	assert.equal(imported.identity.managed[0].fingerprint,digest(changed));
	assert.deepEqual((await readVaultRegistry(disk)).paths,['Here/Imported']);
});

test('relocation keeps the UUID and untouched missing paths, while a confirmed copy gets a new UUID',async t=>{
	const {disk,config,create,assets,visible} = await setup(t);
	const original = await create('New/Library');
	await writeVaultRegistry(disk,null,['Old/Library','Old/Other']);
	const before = await discover(disk,config);
	assert.equal(before.filter(lib=>lib.missing).length,2);
	const old = {location:'Old/Library',id:original.identity.id};
	await assert.rejects(previewImport(disk,config,'New/Library',assets,{...old,id:'wrong'}));
	const plan = await previewImport(disk,config,'New/Library',assets,old);
	await confirmImport(disk,config,plan,'register',assets,visible);
	assert.deepEqual((await readVaultRegistry(disk)).paths,['New/Library','Old/Other']);
	await create('Copy/Library',original.identity);
	const copy = await previewImport(disk,config,'Copy/Library',assets);
	assert.deepEqual(copy.clashes.map(lib=>lib.location),['New/Library']);
	await confirmImport(disk,config,copy,'copy',assets,visible);
	const registered = await discover(disk,config);
	assert.equal(registered.find(lib=>lib.location==='New/Library').identity.id,original.identity.id);
	assert.notEqual(registered.find(lib=>lib.location==='Copy/Library').identity.id,original.identity.id);
	assert.equal(registered.some(lib=>lib.duplicate),false);
	assert.equal(registered.find(lib=>lib.location==='Old/Other').missing,true);
});

test('Vault root ignore preview preserves the existing bytes and refuses stale confirmation',async t=>{
	const {root,disk} = await setup(t);
	const file = path.join(root,'.gitignore');
	const rule = registryIgnoreFor(configDir);
	assert.equal(rule,`/${configDir}/plugins/knowledge-base-manager/data.json`);
	const initial = '# existing\r\n*.tmp';
	await fs.writeFile(file,initial);
	const stale = await previewRegistryIgnore(disk);
	assert.equal(await fs.readFile(file,'utf8'),initial);
	await fs.appendFile(file,'\r\n!data.json');
	await assert.rejects(applyIgnoreRule(disk,stale));
	const preview = await previewRegistryIgnore(disk);
	await applyIgnoreRule(disk,preview);
	assert.equal(await fs.readFile(file,'utf8'),initial+'\r\n!data.json\r\n'+rule+'\r\n');
	const final = await previewRegistryIgnore(disk);
	assert.equal(final.before,final.after);
});

test('the root Git ignore rule matches only the plugin data for a custom Vault configuration',async t=>{
	const settingsDir = '.custom [1]';
	const {root,disk} = await setup(t,settingsDir);
	await applyIgnoreRule(disk,await previewRegistryIgnore(disk));
	execFileSync('git',['-C',root,'init','-q']);
	const matches = (relative) => spawnSync('git',['-C',root,'check-ignore','-q','--',relative]);
	const ownData = matches(registryDataPath(settingsDir));
	assert.ifError(ownData.error);
	assert.equal(ownData.status,0);
	for (const other of [registryDataPath('.custom 1'),registryDataPath(configDir),`${settingsDir}/plugins/other/data.json`,
		`${settingsDir}/plugins/knowledge-base-manager/manifest.json`,oldRegistryPath]) {
		const result = matches(other);
		assert.ifError(result.error);
		assert.equal(result.status,1,other);
	}
});

test('copying the complete library to a second Vault restores the ID, preferences, data and Git history',async t=>{
 const source=await setup(t),target=await setup(t);
 const from='Research/Reading',to='Restored/Reading';
 const {identity,manifest}=await source.create(from);
 const src=await source.disk.path(from),dst=await target.disk.path(to);
 const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
 await fs.writeFile(path.join(src,'.gitignore'),'/kb.toml\n');
 await fs.writeFile(path.join(src,'Reading.md'),'Handwritten notes\n');
 git(src,'init','-q','-b','main');
 git(src,'add','-A');
 git(src,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Original notes');
 await registerVaultLibrary(source.disk,source.config,from);
 await fs.mkdir(path.dirname(dst),{recursive:true});
 await fs.cp(src,dst,{recursive:true});
 const plan=await previewImport(target.disk,target.config,to,target.assets);
 await confirmImport(target.disk,target.config,plan,'rebind',target.assets,target.visible);
 const [lib]=await discover(target.disk,target.config);
 assert.equal(lib.identity.id,identity.id);
 assert.deepEqual(lib.preferences,{showFileMenu:false});
 assert.equal(lib.identity.managed[0].root,to);
 assert.equal(git(dst,'rev-parse','HEAD'),git(src,'rev-parse','HEAD'));
 assert.equal(git(dst,'check-ignore','--','kb.toml'),'kb.toml');
 assert.equal(git(dst,'ls-tree','-r','--name-only','HEAD','--','kb.toml'),'');
 assert.equal(await fs.readFile(path.join(dst,'Reading.md'),'utf8'),'Handwritten notes\n');
 assert.equal(await fs.readFile(path.join(src,'kb.toml'),'utf8'),manifest);
 assert.deepEqual((await readVaultRegistry(source.disk)).paths,[from]);
 assert.deepEqual((await readVaultRegistry(target.disk)).paths,[to]);
});
