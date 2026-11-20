import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {templateCatalog} from '../scripts/template-catalog.mjs';
import {VaultDisk,digest} from '../src/fs/vault.ts';
import {parseIdentity,writeIdentity} from '../src/kb/identity-core.ts';
import {instanceText,rebindSlots} from '../src/kb/instance-text.ts';
import {declaration} from '../src/kb/template-declaration.ts';

const {packs,digests}=templateCatalog(path.resolve('assets/templates'));
global.KB_TEMPLATE_PACKS=packs;
global.KB_CHECK_DIGESTS=digests;
const {builtinPacks,renderPack}=await import('../src/kb/template-pack.ts');
const {previewCreate,createLibrary}=await import('../src/kb/create.ts');
const {discover}=await import('../src/kb/catalog.ts');
const {examineBindings}=await import('../src/kb/maintenance.ts');
const {planMove,executeMove}=await import('../src/kb/move.ts');

test('template catalogue is unique and binary files round-trip without decoding',()=>{
	assert.equal(builtinPacks().length,18);
	assert.equal(new Set(builtinPacks().map(spec=>spec.purpose)).size,9);
	for(const spec of builtinPacks()){
		const vars={destination:'资料/案例',displayName:'案例',description:'描述'};
		const pack=renderPack(spec.id,vars);
		for(const [name,b64] of Object.entries(packs[spec.id].binary)){
			assert.deepEqual(Buffer.from(pack.files.find(file=>file.name===name).bytes),Buffer.from(b64,'base64'));
		}
		const publicFile=pack.files.find(file=>file.name==='kb-template.json');
		assert.deepEqual(declaration(new TextDecoder().decode(publicFile.bytes)),spec);
	}
});

test('declared root positions survive multiple renames, literal equal text and apostrophes',()=>{
	const old="库/O'Brien",next='库/新目录';
	const vars={destination:old,displayName:old,description:''};
	const source='views:\n  - type: table\n    name: "本库"\nfilters: \'file.inFolder("{{kb_root}}")\'\n';
	const base=instanceText('现有.base',source,['kb_root'],vars);
	assert.equal(parse(base.content).filters,'file.inFolder("'+old+'")');
	assert.equal(parse(rebindSlots(base.content,base.offsets,old,next)).filters,'file.inFolder("'+next+'")');
	const page=instanceText('页面.md','{{kb_name}} [[{{kb_root}}/甲]] [[{{kb_root}}/乙]] {{title}}',['kb_name','kb_root'],vars);
	const rebound=rebindSlots(page.content,page.offsets,old,next);
	assert.equal(rebound,old+' [['+next+'/甲]] [['+next+'/乙]] {{title}}');
	assert.equal(rebindSlots(rebound,page.offsets,next,old),page.content);
	assert.throws(()=>rebindSlots('changed',page.offsets,old,next));
	const id={schemaVersion:1,id:'844ce60b-0480-42bc-84df-17e6cbe425a8',displayName:'旧库',description:'',archived:false,template:{id:'folder',version:'1'},managed:[]};
	const raw=writeIdentity('version = 1 # compatible\n[preferences]\ntree = false\n[x]\nkeep = 7\n',id);
	const upgraded=writeIdentity(raw,{...id,schemaVersion:2});
	assert.deepEqual(parseIdentity(upgraded),{...parseIdentity(raw),schemaVersion:2});
	assert.match(upgraded,/version = 2 # compatible/u);
	assert.match(upgraded,/tree = false\n\[x\]\nkeep = 7/u);
});

test('new pack gets independent identity, public rules, ignored logs and previewed move',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','v3-lifecycle-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk=new VaultDisk(root,'.settings'),config={parents:['资料'],templates:[]};
	const input={source:'builtin:research-project',parent:'资料',name:'实验甲',displayName:'实验',description:'测试'};
	const preview=await previewCreate(disk,config,input,{});
	await createLibrary(disk,config,preview,{});
	const copy=await previewCreate(disk,config,{...input,name:'实验乙'},{});
	await createLibrary(disk,config,copy,{});
	const items=await discover(disk,config),first=items.find(i=>i.location===preview.location),second=items.find(i=>i.location===copy.location);
	assert.notEqual(first.identity.id,second.identity.id);
	assert.equal(first.identity.schemaVersion,2);
	const original=path.join(root,preview.location);
	const git=(...args)=>execFileSync('git',['-C',original,...args],{encoding:'utf8'}).trim();
	assert.equal(git('check-ignore','--','.log/report.json'),'.log/report.json');
	assert.match(git('ls-files','--','checks','kb-template.json'),/checks\/workflow\.mjs/u);
	const [edited]=first.identity.managed;
	const modified=await disk.path(preview.location+'/'+edited.path);
	await fs.appendFile(modified,'\n用户编辑');
	const dest='资料/已移动';
	const findings=await examineBindings(disk,first,{},dest);
	assert.ok(findings.manual.some(text=>text.includes(edited.path)));
	assert.ok(findings.repairs.length);
	const move=await planMove(disk,config,first,'资料','已移动',{});
	const visible={async replace(relative,before,after){
		const f=await disk.path(relative);
		assert.equal(digest(await fs.readFile(f)),before);
		await fs.writeFile(f,after);
	}};
	await executeMove(disk,config,move,visible,async()=>{});
	assert.ok((await fs.readFile(await disk.path(dest+'/'+edited.path),'utf8')).endsWith('用户编辑'));
	for(const repair of findings.repairs){
		assert.equal(await fs.readFile(await disk.path(dest+'/'+repair.file),'utf8'),repair.after);
		assert.ok(repair.after.includes(dest));
	}
});
