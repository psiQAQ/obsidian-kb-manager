import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest} from '../src/fs/vault.ts';
import {newIdentity,discover,identityFile,writeIdentity} from '../src/kb/catalog.ts';
import {registerVaultLibrary} from '../src/registry/discovery.ts';
import {initializeRepository} from '../src/git/repository.ts';
import {renderBase} from '../src/kb/template.ts';
import {examine,applyRepair} from '../src/kb/maintenance.ts';
import {planMove,executeMove} from '../src/kb/move.ts';
import {templateFolderRule} from '../src/kb/template-exclusions.ts';
import {vaultDisk} from './fixtures/vault-disk.mjs';

test('resume a root-level library move after its Obsidian exclusion write fails',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','move-exclusions-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk=vaultDisk(root,'.settings'), config={parents:[],templates:[]};
	const source='甲[1]', parent='项目', target='乙+1', destination=parent+'/'+target;
	const identity=newIdentity('甲','',{id:'personal',version:'1'});
	identity.excludedFolders=['页面模板','辅助'];
	await fs.mkdir(path.join(root,source));
	await fs.mkdir(path.join(root,parent));
	await fs.writeFile(path.join(root,source,identityFile),writeIdentity('',identity));
	await registerVaultLibrary(disk,config,source);
	const oldRule=templateFolderRule(source,'页面模板'), newRule=templateFolderRule(destination,'页面模板');
	const manual=templateFolderRule(source,'辅助');
	let rules=['keep/',oldRule,manual], owner={owner:{root:source,rules:[oldRule]}}, fail=true;
	const store={
		async readRules(){return [...rules];},
		async writeRules(before,after){
			assert.deepEqual(before,rules);
			if(fail)throw Error('test: failed settings write');
			rules=[...after];
		},
		async readOwnership(id){assert.equal(id,identity.id);return owner;},
		async writeOwnership(id,before,after){
			assert.equal(id,identity.id);
			assert.deepEqual(before,owner);
			owner=structuredClone(after);
		},
	};
	const [library]=await discover(disk,config);
	let record=await planMove(disk,config,library,parent,target,{},store);
	const run=()=>executeMove(disk,config,record,{},async value=>{record=structuredClone(value);},{},store);
	assert.deepEqual(record.exclusions.remove,[oldRule]);
	assert.deepEqual(record.exclusions.add,[newRule]);
	await assert.rejects(run(),/failed settings write/);
	assert.equal(record.phase,'moved');
	assert((await fs.stat(path.join(root,destination))).isDirectory());
	assert.deepEqual(rules,['keep/',oldRule,manual]);
	fail=false;
	await run();
	assert.equal(record.phase,'complete');
	assert.deepEqual(rules,['keep/',manual,newRule]);
	assert.deepEqual(owner,{owner:{root:destination,rules:[newRule]}});
	assert.deepEqual((await discover(disk,config)).map(lib=>lib.location),[destination]);
});

test('move resumes after rename, refuses a new edit, preserves staged bytes and custom filters',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','move-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk=vaultDisk(root,'.settings'),config={parents:['A','B'],templates:[],author:'',email:''};
	const libdir=path.join(root,'A','光学');
	await fs.mkdir(libdir,{recursive:true});await fs.mkdir(path.join(root,'B'));
	const skeleton={'knowledge.base':await fs.readFile('assets/templates/ai-workflows/llm-wiki/knowledge.base','utf8')};
	const base=renderBase(skeleton['knowledge.base'],'A/光学').replace('file.inFolder("A/光学/Notes")','file.name == "私人条件"')+'\n# 人工注释\n';
	const manifest=newIdentity('光学','本地',{id:'llm-wiki',version:'1'});
	manifest.managed.push({path:'knowledge.base',fingerprint:digest(base),root:'A/光学'});
	const manifestText=writeIdentity('',manifest);
	await fs.writeFile(path.join(libdir,identityFile),manifestText);
	await fs.writeFile(path.join(libdir,'knowledge.base'),base);
	await registerVaultLibrary(disk,config,'A/光学');
	await fs.writeFile(path.join(root,'outside.md'),'[[A/光学/note]]');
	await initializeRepository(libdir);
	const git=(dir,...args)=>execFileSync('git',['-C',dir,...args]);
	await fs.writeFile(path.join(libdir,'note.md'),'initial');git(libdir,'add','note.md');
	git(libdir,'-c','user.name=Test','-c','user.email=t@example.invalid','commit','-qm','first');
	await fs.writeFile(path.join(libdir,'note.md'),'index');git(libdir,'add','note.md');
	await fs.writeFile(path.join(libdir,'note.md'),'work');
	await fs.writeFile(path.join(libdir,'.hidden'),Buffer.from([0,1,255,13,10]));
	await fs.writeFile(path.join(libdir,'attachment.bin'),Buffer.from([255,10,0]));
	const head=git(libdir,'rev-parse','HEAD'),index=await fs.readFile(path.join(libdir,'.git/index'));
	const [lib]=await discover(disk,config);
	const originals=new Map();
	const record=await planMove(disk,config,lib,'B','新 光学',skeleton,undefined,originals);
	assert.deepEqual(originals,new Map([['knowledge.base',base],[identityFile,manifestText]]));
	assert.ok(record.warnings.some(w=>w.includes('人工笔记')));
	const dest=path.join(root,'B','新 光学');
	let saved;
	const persist=r=>{saved=structuredClone(r);return Promise.resolve();};
	const files={
		async replace(relative,before,after){
			const f=await disk.path(relative);
			assert.equal(digest(await fs.readFile(f)),before);
			await fs.writeFile(f,after);
		},
		async create(relative,content){await fs.writeFile(await disk.path(relative),content,{flag:'wx'});}
	};
	await assert.rejects(executeMove(disk,config,record,{...files,replace:()=>Promise.reject(new Error('interrupted'))},persist),/interrupted/);
	assert.equal(saved.phase,'moved');
	assert.equal(Object.hasOwn(saved,'originals'),false);
	for(const change of saved.changes)assert.deepEqual(Object.keys(change).sort(),['after','before','fields','file']);
	const moved=path.join(dest,'knowledge.base');
	const previous=await fs.readFile(moved,'utf8');
	await fs.writeFile(moved,previous+'# new edit');
	await assert.rejects(executeMove(disk,config,saved,files,persist),/编辑/);
	await fs.writeFile(moved,previous);
	await executeMove(disk,config,saved,files,persist);
	assert.equal(saved.phase,'complete');
	assert.deepEqual(git(dest,'rev-parse','HEAD'),head);
	assert.deepEqual(await fs.readFile(path.join(dest,'.git/index')),index);
	assert.equal(await fs.readFile(path.join(dest,'note.md'),'utf8'),'work');
	assert.deepEqual(await fs.readFile(path.join(dest,'.hidden')),Buffer.from([0,1,255,13,10]));
	assert.deepEqual(await fs.readFile(path.join(dest,'attachment.bin')),Buffer.from([255,10,0]));
	assert.equal(await fs.readFile(path.join(root,'outside.md'),'utf8'),'[[A/光学/note]]');
	const text=await fs.readFile(moved,'utf8');
	assert.ok(text.includes('私人条件') && text.includes('# 人工注释') && text.includes('B/新 光学'));
	const [current]=await discover(disk,config);
	assert.equal(current.identity.id,manifest.id);
	assert.deepEqual((await examine(disk,current,skeleton)).repairs,[]);
	await fs.unlink(moved);
	const repairOriginals=new Map();
	const [repair]=(await examine(disk,current,skeleton,current.location,repairOriginals)).repairs;
	assert.equal(repair.before,null);
	assert.equal(repairOriginals.has(repair.file),false);
	await applyRepair(disk,config,current,repair,files,skeleton);
	const repaired=(await discover(disk,config))[0];
	const intermediate=await planMove(disk,config,repaired,'B','Optics',skeleton);
	await executeMove(disk,config,intermediate,files,persist);
	const renamed=(await discover(disk,config))[0];
	const caseOnly=await planMove(disk,config,renamed,'B','OPTICS',skeleton);
	await executeMove(disk,config,caseOnly,files,persist);
	assert.deepEqual(await fs.readdir(path.join(root,'B')),['OPTICS']);
	assert.deepEqual((await examine(disk,(await discover(disk,config))[0],skeleton)).repairs,[]);
});
