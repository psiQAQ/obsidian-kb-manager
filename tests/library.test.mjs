import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { VaultDisk } from '../src/fs/vault.ts';
import { defaults, discover } from '../src/kb/catalog.ts';
import { adopt, createLibrary, previewCreate } from '../src/kb/create.ts';
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
