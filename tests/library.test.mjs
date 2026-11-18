import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { VaultDisk } from '../src/fs/vault.ts';
import { defaults, discover } from '../src/kb/catalog.ts';
import { ancestorWarnings, legacyBinding, adopt, createLibrary, previewCreate } from '../src/kb/create.ts';
import { inspectSources } from '../src/kb/sources.ts';
import { readMapping } from '../src/kb/mapping.ts';

async function setup(t) {
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','kb-test-'));
	t.after(()=>fs.rm(root,{force:true,recursive:true}));
	const disk=new VaultDisk(root,'.settings');
	const config={...defaults,templates:['样板']};
	const skeleton={};
	const assets=path.resolve('assets/llm-wiki');
	for(const item of await fs.readdir(assets,{recursive:true,withFileTypes:true})){
		if(item.isFile()){
			const absolute=path.join(item.parentPath,item.name);
			skeleton[path.relative(assets,absolute).split(path.sep).join('/')]=await fs.readFile(absolute,'utf8');
		}
	}
	const input={parent:'knowledge-base',name:'光学 研究',displayName:'光学',description:'研究',source:''};
	return {root,disk,config,skeleton,input};
}
test('built-in creation renders scoped Base, preserves note variables, rejects concurrent duplicate',async t=>{
	const {disk,config,input,skeleton}=await setup(t);
	const p=await previewCreate(disk,config,input,skeleton);
	const attempts=await Promise.allSettled([createLibrary(disk,config,p,skeleton),createLibrary(disk,config,p,skeleton)]);
	assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
	const [lib]=await discover(disk,config);
	assert.equal(lib.identity.displayName,input.displayName);
	const root=await disk.path(lib.location);
	const base=parse(await fs.readFile(path.join(root,'knowledge.base'),'utf8'));
	assert.ok(base.views[1].filters.and.includes('file.inFolder("knowledge-base/光学 研究/Notes")'));
	assert.equal(await fs.readFile(path.join(root,'templates/人工笔记模板.md'),'utf8'),skeleton['templates/人工笔记模板.md']);
	assert.equal(execFileSync('git',['-C',root,'for-each-ref']).length,0);
	assert.equal((await discover(new VaultDisk(disk.root,'.settings'),config))[0].identity.id,lib.identity.id);
});
test('folder template preserves binary bytes, empty directories, excluded paths and preview identity',async t=>{
	const {disk,root,config,input,skeleton}=await setup(t);
	const template=path.join(root,'样板');
	await fs.mkdir(path.join(template,'empty'),{recursive:true});
	await fs.mkdir(path.join(template,'.settings'));
	const bytes=Buffer.from([0,255,13,10,128]);
	await fs.writeFile(path.join(template,'data.pdf'),bytes);
	await fs.writeFile(path.join(template,'note.md'),'{{kb_name}}');
	input.source='样板';
	const p=await previewCreate(disk,config,input,skeleton);
	assert.deepEqual(p.template.excluded,['.settings']);
	await fs.writeFile(path.join(template,'note.md'),'{{kb_name}}!');
	await assert.rejects(createLibrary(disk,config,p,skeleton),/changed/);
	await createLibrary(disk,config,await previewCreate(disk,config,input,skeleton),skeleton);
	const dir=await disk.path(p.location);
	assert.deepEqual(await fs.readFile(path.join(dir,'data.pdf')),bytes);
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'{{kb_name}}!');
	assert.deepEqual(await fs.readdir(path.join(dir,'empty')),[]);
});
test('adoption preserves branch, HEAD, staged bytes and working copy; duplicate ID detected',async t=>{
	const {disk,config,root,skeleton}=await setup(t);
	const dir=path.join(root,'knowledge-base','旧库');
	await fs.mkdir(dir,{recursive:true});
	const toml=skeleton['kb.toml'].replaceAll('"wiki','"知识');
	await fs.writeFile(path.join(dir,'kb.toml'),toml);
	const run=(...args)=>execFileSync('git',['-C',dir,...args]);
	run('init','-q','-b','legacy');run('add','kb.toml');
	run('-c','user.name=Tester','-c','user.email=t@example.invalid','commit','-qm','legacy');
	const head=run('rev-parse','HEAD');
	await fs.writeFile(path.join(dir,'note.md'),'index');run('add','note.md');
	await fs.writeFile(path.join(dir,'note.md'),'work');
	const index=await fs.readFile(path.join(dir,'.git/index'));
	const [old]=await discover(disk,config);
	assert.equal(old.mapping.wiki,'知识');
	await adopt(disk,config,old,[]);
	assert.deepEqual(await fs.readFile(path.join(dir,'.git/index')),index);
	assert.deepEqual(run('rev-parse','HEAD'),head);
	assert.equal(run('branch','--show-current').toString().trim(),'legacy');
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'work');
	assert.equal(await fs.readFile(path.join(dir,'kb.toml'),'utf8'),toml);
	await fs.cp(dir,path.join(root,'knowledge-base','副本'),{recursive:true});
	assert.ok((await discover(disk,config)).every(lib=>lib.duplicate));
	assert.throws(()=>readMapping(toml.replace('raw = "raw"','raw = "Notes"')),/overlap/iu);
});

test('declared template fields, legacy opt-in and snapshot nanoseconds',async t=>{
	const {disk,root,config,skeleton,input}=await setup(t);
	const dir=path.join(root,'样板');
	await fs.mkdir(dir);
	await fs.writeFile(path.join(dir,'knowledge.base'),skeleton['knowledge.base']);
	await fs.writeFile(path.join(dir,'README.md'),'{{kb_name}} {{date:YYYY-MM-DD}}');
	await fs.writeFile(path.join(dir,'kb-template.json'),JSON.stringify({
		id:'custom',entry:'README.md',managed:['knowledge.base:overview-bindings'],text:{'README.md':['kb_name']}
	}));
	const preview=await previewCreate(disk,config,{...input,source:'样板'},skeleton);
	await createLibrary(disk,config,preview,skeleton);
	const [custom]=await discover(disk,config);
	assert.equal(custom.identity.managed[0].role,'overview-bindings');
	assert.equal(await fs.readFile(await disk.path(custom.location+'/README.md'),'utf8'),'光学 {{date:YYYY-MM-DD}}');
	const legacy=path.join(root,'knowledge-base','旧库');
	await fs.mkdir(legacy);await fs.mkdir(path.join(legacy,'raw'));await fs.mkdir(path.join(legacy,'Notes'));
	await fs.writeFile(path.join(legacy,'kb.toml'),skeleton['kb.toml']);
	const base=await fs.readFile(await disk.path(custom.location+'/knowledge.base'),'utf8');
	await fs.writeFile(path.join(legacy,'knowledge.base'),base.replaceAll(custom.location,'knowledge-base/旧库'));
	const lib=(await discover(disk,config)).find(l=>!l.identity);
	const candidate=await legacyBinding(disk,lib);
	assert.ok(candidate);
	const manifest=await adopt(disk,config,lib,[],candidate);
	assert.equal(manifest.template.id,'unknown');
	assert.equal(manifest.managed.length,1);
	const note=path.join(legacy,'Notes','原件.md');
	await fs.writeFile(note,'abc');
	const stamp=(await fs.stat(note,{bigint:true})).mtimeNs.toString();
	assert.equal(execFileSync(process.platform==='win32'?'python':'python3',['-c','import os, sys; print(os.stat(sys.argv[1]).st_mtime_ns)',note]).toString().trim(),stamp);
	const snapshot=path.join(legacy,'raw','快照.md');
	await fs.writeFile(snapshot,'---\nsnapshot_source_note: "../Notes/原件.md"\nsnapshot_source_mtime_ns: "'+stamp+'"\n---\n');
	assert.deepEqual(await inspectSources(disk,lib),[]);
	await fs.utimes(note,1000,1000);
	assert.equal((await inspectSources(disk,lib)).length,1);
	assert.ok((await fs.readFile(snapshot,'utf8')).includes(stamp));
});

test('parent repository exposure appears in preview without modifying its index',async t=>{
	const {root,disk}=await setup(t);
	const run=(...args)=>execFileSync('git',['-C',root,...args]);
	run('init','-q','-b','parent');
	await fs.writeFile(path.join(root,'.gitignore'),'knowledge-base/ignored/\n');
	await fs.mkdir(path.join(root,'knowledge-base','tracked'),{recursive:true});
	await fs.writeFile(path.join(root,'knowledge-base','tracked','note.md'),'tracked');
	run('add','.gitignore','knowledge-base/tracked/note.md');
	const index=path.join(root,'.git','index');
	const previous=await fs.readFile(index);
	assert.match((await ancestorWarnings(disk,'knowledge-base/tracked'))[0],/已被跟踪/);
	assert.match((await ancestorWarnings(disk,'knowledge-base/ignored'))[0],/目标已被忽略/);
	assert.match((await ancestorWarnings(disk,'knowledge-base/fresh'))[0],/未被忽略/);
	assert.deepEqual(await fs.readFile(index),previous);
});
