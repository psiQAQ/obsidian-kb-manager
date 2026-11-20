import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { userInfo } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { VaultDisk } from '../src/fs/vault.ts';
import { defaults, discover, scan, newIdentity, readManifest, writeIdentity, writePreferences } from '../src/kb/catalog.ts';
import { ancestorWarnings, adoptionWarnings, legacyBinding, adopt, createLibrary, CreationInterrupted, previewCreate, resumeCreation, reviewInterruptedCreation } from '../src/kb/create.ts';
import { initialIdentityDefaults } from '../src/git/initial.ts';
import { headOid, readCommit } from '../src/git/repository.ts';
import { registerVaultLibrary } from '../src/registry/discovery.ts';
import { auditLibrary } from '../src/kb/audit.ts';
import {instanceManifestSeed} from '../src/kb/template-declaration.ts';
import { readMapping } from '../src/kb/mapping.ts';

async function setup(t) {
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','kb-test-'));
	t.after(()=>fs.rm(root,{force:true,recursive:true}));
	const global=path.join(root,'global.gitconfig');
	await fs.writeFile(global,'');
	const vars=['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL','EMAIL'];
	const before=Object.fromEntries(vars.map(key=>[key,process.env[key]]));
	for(const key of vars)delete process.env[key];
	Object.assign(process.env,{GIT_CONFIG_GLOBAL:global,GIT_CONFIG_NOSYSTEM:'1'});
	t.after(()=>{
		for(const [key,value] of Object.entries(before)){
			if(value===undefined)delete process.env[key];
			else process.env[key]=value;
		}
	});
	const disk=new VaultDisk(root,'.settings');
	const config={...defaults,templates:['样板']};
	const skeleton={};
	const assets=path.resolve('assets/templates/ai-workflows/llm-wiki');
	for(const item of await fs.readdir(assets,{recursive:true,withFileTypes:true})){
		if(item.isFile()){
			const absolute=path.join(item.parentPath,item.name);
			skeleton[path.relative(assets,absolute).split(path.sep).join('/')]=await fs.readFile(absolute,'utf8');
		}
	}
	skeleton['kb.toml']=instanceManifestSeed(JSON.parse(skeleton['kb-template.json']),1);
	const input={parent:'knowledge-base',name:'光学 研究',displayName:'光学',description:'研究',source:''};
	return {root,disk,config,skeleton,input,global};
}
test('built-in creation renders scoped Base, preserves note variables, rejects concurrent duplicate',async t=>{
	const {disk,config,input,skeleton}=await setup(t);
	const p=await previewCreate(disk,config,input,skeleton);
	assert.equal(p.git.identity.name.source,'login');
	assert.equal(p.git.identity.name.value,userInfo().username);
	assert.equal(p.git.identity.email.source,'placeholder');
	assert.match(p.git.identity.email.value,/@users\.invalid$/u);
	assert.ok(p.git.staged.includes('knowledge.base'));
	assert.deepEqual(p.git.ignored,['kb.toml']);
	assert.equal(await fs.stat(await disk.path(p.location)).catch(error=>error.code),'ENOENT');
	const attempts=await Promise.allSettled([createLibrary(disk,config,p,skeleton),createLibrary(disk,config,p,skeleton)]);
	assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
	const [lib]=await discover(disk,config);
	assert.equal(lib.identity.displayName,input.displayName);
	const root=await disk.path(lib.location);
	const base=parse(await fs.readFile(path.join(root,'knowledge.base'),'utf8'));
	assert.ok(base.views[1].filters.and.includes('file.inFolder("knowledge-base/光学 研究/Notes")'));
	assert.equal(await fs.readFile(path.join(root,'Templates/人工笔记模板.md'),'utf8'),skeleton['Templates/人工笔记模板.md'].replace(/\r\n/gu,'\n'));
	const run=(...args)=>execFileSync('git',['-C',root,...args]).toString().trim();
	assert.equal(run('for-each-ref','--format=%(refname)'),'refs/heads/main');
	assert.equal(run('rev-list','--count','HEAD'),'1');
	assert.equal(run('log','-1','--format=%s'),'Initial commit');
	assert.equal(run('status','--porcelain'),'');
	assert.equal(run('remote'),'');
	assert.deepEqual(run('ls-files','-z').split('\0').filter(Boolean).sort(),p.git.staged);
	assert.match(execFileSync('git',['-C',root,'check-ignore','-v','kb.toml']).toString(),/\.gitignore:.*:\/kb\.toml/u);
	assert.deepEqual((await fs.readdir(root)).filter(name=>name.startsWith('kb-')),['kb-template.json']);
	assert.equal((await discover(new VaultDisk(disk.root,'.settings'),config))[0].identity.id,lib.identity.id);
});
test('folder template respects ignored files, preserves binary files, and writes only edited identity fields and origin',async t=>{
	const {disk,root,config,input,skeleton,global}=await setup(t);
	const template=path.join(root,'样板');
	await fs.mkdir(path.join(template,'empty'),{recursive:true});
	await fs.mkdir(path.join(template,'.settings'));
	await fs.mkdir(path.join(template,'cache'));
	await fs.writeFile(path.join(template,'cache','local.bin'),'local');
	const bytes=Buffer.from([0,255,13,10,128]);
	await fs.writeFile(path.join(template,'data.pdf'),bytes);
	await fs.writeFile(path.join(template,'note.md'),'{{kb_name}}');
	await fs.writeFile(path.join(template,'.gitignore'),'# user ignore\r\ncache/\r\n!kb.toml\r\n');
	await fs.writeFile(global,'[user]\n name = Global Tester\n email = global@example.invalid\n');
	const defaults=await initialIdentityDefaults();
	assert.equal(defaults.name.value,'Global Tester');
	assert.equal(defaults.email.value,'global@example.invalid');
	assert.equal(defaults.email.source,'global');
	input.git={defaults,values:{name:'Edited Tester',email:defaults.email.value},origin:'git@offline.example.invalid:repo/lib.git'};
	input.source='样板';
	const p=await previewCreate(disk,config,input,skeleton);
	assert.deepEqual(p.template.excluded,['.settings']);
	assert.deepEqual(p.git.ignored,['cache/local.bin','kb.toml']);
	assert.deepEqual(p.git.staged,['.gitignore','data.pdf','note.md']);
	assert.equal(p.git.identity.name.source,'local');
	assert.equal(p.git.identity.email.source,'global');
	await fs.writeFile(path.join(template,'note.md'),'{{kb_name}}!');
	await assert.rejects(createLibrary(disk,config,p,skeleton),/changed/);
	const result=await createLibrary(disk,config,await previewCreate(disk,config,input,skeleton),skeleton);
	const dir=await disk.path(p.location);
	const run=(...args)=>execFileSync('git',['-C',dir,...args]).toString().trim();
	const {commit}=await readCommit(dir,result.head);
	assert.equal(commit.author.name,'Edited Tester');
	assert.equal(commit.committer.email,'global@example.invalid');
	assert.deepEqual(commit.parent,[]);
	const local=run('config','--local','--list');
	assert.match(local,/^user\.name=Edited Tester$/mu);
	assert.doesNotMatch(local,/^user\.email=|^branch\.main\./mu);
	assert.equal(run('config','--local','remote.origin.url'),input.git.origin);
	assert.equal(run('status','--porcelain'),'');
	assert.deepEqual(await fs.readFile(path.join(dir,'data.pdf')),bytes);
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'{{kb_name}}!');
	assert.equal(await fs.readFile(path.join(dir,'cache','local.bin'),'utf8'),'local');
	assert.deepEqual(await fs.readdir(path.join(dir,'empty')),[]);
	assert.equal(await fs.readFile(path.join(dir,'.gitignore'),'utf8'),'# user ignore\r\ncache/\r\n!kb.toml\r\n/.log/\r\n/kb.toml\r\n');
	const {identity,mapping}=readManifest(await fs.readFile(path.join(dir,'kb.toml'),'utf8'));
	assert.equal(identity.displayName,input.displayName);
	assert.equal(mapping,undefined);
});

test('system EMAIL is used only when valid, and an author environment change invalidates confirmation',async t=>{
	const {disk,config,input,skeleton}=await setup(t);
	process.env.EMAIL='bad address@example.invalid';
	assert.equal((await initialIdentityDefaults()).email.source,'placeholder');
	process.env.EMAIL='mail@example.invalid';
	const p=await previewCreate(disk,config,input,skeleton);
	assert.deepEqual(p.git.identity.email,{value:'mail@example.invalid',source:'environment',origin:'EMAIL'});
	process.env.GIT_AUTHOR_NAME='An unexpected author';
	await assert.rejects(createLibrary(disk,config,p,skeleton),/GIT_AUTHOR_IDENT/u);
	assert.equal(await fs.stat(await disk.path(p.location)).catch(error=>error.code),'ENOENT');
	assert.deepEqual(await discover(disk,config),[]);
});

test('an includeIf at the final path requires reconfirmation and registration retry keeps the same root commit',async t=>{
	const {disk,config,input,skeleton,root,global}=await setup(t);
	const dir=await disk.path(input.parent+'/'+input.name),condition=path.join(root,'conditional.gitconfig');
	await fs.writeFile(condition,'[user]\n email = final@example.invalid\n');
	const gitdir=path.join(dir,'.git').split(path.sep).join('/');
	await fs.writeFile(global,'[user]\n name = Tester\n email = default@example.invalid\n[includeIf "gitdir:'+gitdir+'"]\n path = conditional.gitconfig\n');
	const p=await previewCreate(disk,config,input,skeleton);
	assert.equal(p.git.identity.email.value,'default@example.invalid');
	const getReceipt=async(perform)=>{
		try{await perform();}catch(error){
			assert.ok(error instanceof CreationInterrupted,String(error));
			return error.receipt;
		}
		assert.fail('Expected recoverable creation failure');
	};
	const first=await getReceipt(()=>createLibrary(disk,config,p,skeleton));
	assert.equal(await headOid(dir),'');
	assert.deepEqual(await discover(disk,config),[]);
	const revised=await reviewInterruptedCreation(disk,first);
	assert.equal(revised.head,'');
	assert.equal(revised.git.identity.email.value,'final@example.invalid');
	assert.match(revised.git.identity.email.origin,/conditional\.gitconfig/u);
	const second=await getReceipt(()=>resumeCreation(disk,config,first,revised,()=>Promise.reject(new Error('Registry is unavailable'))));
	const committed=await headOid(dir);
	assert.match(committed,/^[a-f0-9]{40}$/u);
	assert.deepEqual(await discover(disk,config),[]);
	const manifestFile=path.join(dir,'kb.toml'),raw=await fs.readFile(manifestFile);
	await fs.appendFile(manifestFile,'\n# edit after commit\n');
	await assert.rejects(reviewInterruptedCreation(disk,second),/已变化|changed/u);
	await fs.writeFile(manifestFile,raw);
	const review=await reviewInterruptedCreation(disk,second);
	const result=await resumeCreation(disk,config,second,review);
	assert.equal(result.head,committed);
	assert.equal((await readCommit(dir,committed)).commit.author.email,'final@example.invalid');
	assert.deepEqual((await readCommit(dir,committed)).commit.parent,[]);
	assert.equal((await discover(disk,config))[0].identity.id,result.manifest.id);
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
	assert.deepEqual(await discover(disk,config),[]);
	const [candidate]=await scan(disk,config);
	await registerVaultLibrary(disk,config,candidate.location);
	const [old]=await discover(disk,config);
	assert.equal(old.mapping.wiki,'知识');
	const warnings=await adoptionWarnings(disk,old);
	assert.match(warnings[0],/kb\.toml/u);
	await adopt(disk,config,old,warnings);
	assert.deepEqual(await fs.readFile(path.join(dir,'.git/index')),index);
	assert.deepEqual(run('rev-parse','HEAD'),head);
	assert.equal(run('branch','--show-current').toString().trim(),'legacy');
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'work');
	const updated=await fs.readFile(path.join(dir,'kb.toml'),'utf8');
	assert.ok(updated.startsWith(toml));
	assert.equal(readManifest(updated).identity.displayName,'旧库');
	await fs.cp(dir,path.join(root,'knowledge-base','副本'),{recursive:true});
	await registerVaultLibrary(disk,config,'knowledge-base/副本');
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
	await registerVaultLibrary(disk,config,'knowledge-base/旧库');
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
	await fs.mkdir(path.join(legacy,'wiki'));
	await fs.writeFile(path.join(legacy,'wiki','page.md'),'---\ntype: concept\nmanaged_by: agent\nsources: ["../raw/快照.md"]\n---\n');
	const snapshots=async()=>(await auditLibrary(disk,lib)).filter(f=>f.code.startsWith('snapshot-'));
	assert.deepEqual(await snapshots(),[]);
	await fs.utimes(note,1000,1000);
	assert.equal((await snapshots()).length,1);
	assert.ok((await fs.readFile(snapshot,'utf8')).includes(stamp));
});

test('manifest changes preserve unrelated TOML fields, comments, BOM and CRLF',()=>{
	const source='\uFEFFversion = 1\r\n# original\r\n[preferences]\r\ntree = false # retain this comment\r\ncustom = ["# annotation", "text"]\r\n[extension]\r\nvalue = """\r\n[manager]\r\nkeep this\r\n"""';
	const recorded=newIdentity('原库','',{id:'folder',version:'1'});
	recorded.managed.push({path:'knowledge.base',root:'A/旧库',fingerprint:'old',role:'overview-bindings'});
	const created=writeIdentity(source,recorded);
	assert.ok(created.startsWith(source));
	const next=readManifest(created).identity;
	next.displayName='Second';
	next.managed[0].root='B/新库';
	const edited=writePreferences(writeIdentity(created,next),{diffStyle:'unified'});
	assert.equal(edited[0],'\uFEFF');
	assert.equal(/(?<!\r)\n/u.test(edited),false);
	assert.ok(edited.includes('# retain this comment\r\ncustom = ["# annotation", "text"]'));
	assert.ok(edited.includes('[extension]\r\nvalue = """\r\n[manager]\r\nkeep this\r\n"""'));
	assert.deepEqual(readManifest(edited),{identity:next,mapping:undefined,preferences:{diffStyle:'unified'}});
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
