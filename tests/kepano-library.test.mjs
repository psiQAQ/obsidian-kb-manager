import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import {gitResult} from '../src/git/network-native.ts';
import {saveVersion,previewVersion} from '../src/git/versions.ts';
import { parseDocument } from 'yaml';
import {parse as parseToml,stringify as stringifyToml} from 'smol-toml';
import { digest } from '../src/fs/vault.ts';
import { defaults, discover } from '../src/kb/catalog.ts';
import { createLibrary, previewCreate } from '../src/kb/create.ts';
import { kepanoSource } from '../src/kb/template.ts';
import { examine, applyRepair } from '../src/kb/maintenance.ts';
import { planMove, executeMove } from '../src/kb/move.ts';
import { referenceEdit } from '../src/kb/move-references.ts';
import { auditLibrary } from '../src/kb/audit.ts';
import { repository } from '../src/git/repository.ts';
import { vaultDisk } from './fixtures/vault-disk.mjs';

async function setup(t) {
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp/kepano-library-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk=vaultDisk(root,'.settings');
	const assets=path.resolve('assets/templates/collections/kepano');
	const skeleton={};
	for(const item of await fs.readdir(assets,{withFileTypes:true,recursive:true})){
		if(!item.isFile())continue;
		const file=path.join(item.parentPath,item.name);
		skeleton[path.relative(assets,file).split(path.sep).join('/')]=await fs.readFile(file,'utf8');
	}
	const config={...defaults,parents:['Libraries','Moved']};
	await fs.mkdir(path.join(root,'Moved'));
	const create=async(name)=>{
		const input={parent:'Libraries',name,source:kepanoSource,displayName:name,description:''};
		const preview=await previewCreate(disk,config,input,skeleton);
		assert.equal(preview.template.id,'kepano');
		assert.ok(preview.template.files.some(f=>f.name==='Templates/Book Template.md'));
		await createLibrary(disk,config,preview,skeleton);
		return (await discover(disk,config)).find(l=>l.location===preview.location);
	};
	const visible={
		async replace(relative,before,text){
			const file=await disk.path(relative);
			assert.equal(digest(await fs.readFile(file)),before);
			await fs.writeFile(file,text);
		},
		async create(relative,text){await fs.writeFile(await disk.path(relative),text,{flag:'wx'});},
	};
	return {disk,skeleton,config,create,visible};
}

test('Kepano creation, independent commits, scoped bindings and selective move/repair',async t=>{
	const {disk,skeleton,config,create,visible}=await setup(t);
	const first=await create('个人 A'), second=await create('个人 B');
	assert.notEqual(first.identity.id,second.identity.id);
	assert.equal(first.identity.entry,'README.md');
	assert.equal(first.mapping,undefined);
	const bookBase='Templates/Bases/Books.base',category='Categories/Books.md',pageTemplate='Templates/Book Template.md';
	assert.ok(!first.identity.managed.some(m=>m.path===category));
	assert.ok(!first.identity.managed.some(m=>m.path===pageTemplate));
	const file=(lib,name)=>disk.path(lib.location+'/'+name);
	const read=async(lib,name)=>fs.readFile(await file(lib,name),'utf8');
	const secondCategory=await read(second,category);
	assert.match(secondCategory,/!\[\[\.\.\/Templates\/Bases\/Books\.base/u);
	assert.equal(await read(first,category),secondCategory);
	assert.ok((await read(first,pageTemplate)).includes('{{date}}'));
	assert.equal((await auditLibrary(disk,first)).filter(f=>f.file.startsWith('Templates/') && f.code==='invalid-metadata').length,0);
	const repos=[repository(await disk.path(first.location)),repository(await disk.path(second.location))];
	for(const [i,repo] of repos.entries()){
		assert.match((await gitResult(repo.dir,['check-ignore','-v','kb.toml'])).stdout.toString(),/\.gitignore:.*:\/kb\.toml/u);
		await fs.writeFile(path.join(repo.dir,'note.md'),String(i));
		await gitResult(repo.dir,['config','--local','user.name','Editor']);
		await gitResult(repo.dir,['config','--local','user.email','test@example.invalid']);
		await gitResult(repo.dir,['add','--','note.md']);
		await saveVersion(repo.dir,await previewVersion(repo.dir),'local '+String(i));
	}
	assert.notDeepEqual((await gitResult(repos[0].dir,['rev-parse','HEAD'])).stdout,(await gitResult(repos[1].dir,['rev-parse','HEAD'])).stdout);
	const stage=await fs.readFile(path.join(repos[0].dir,'.git/index'));
	const doc=parseDocument(await read(first,bookBase));
	doc.setIn(['filters','and',1],'file.name == "My books"');
	await fs.writeFile(await file(first,bookBase),doc.toString());
	const manual='My own link [['+first.location+'/Categories/Books]]';
	await fs.writeFile(await file(first,'note.md'),manual);
	await assert.rejects(planMove(disk,config,first,'Moved','ambiguous#link',skeleton),/#/u);
	const move=await planMove(disk,config,first,'Moved','我的 B',skeleton);
	assert.ok(!move.changes.some(c=>c.file===bookBase));
	assert.ok(!move.changes.some(c=>c.file==='note.md'));
	const link='[['+first.location+'/Categories/Books]]';
	move.references=[referenceEdit(first.location+'/note.md',first,manual,move,{kind:'markdown',
		tokens:[{offset:manual.indexOf(link),original:link,target:first.location+'/'+category}]})];
	await fs.writeFile(await file(first,'note.md'),manual+'\nnew edit');
	await assert.rejects(executeMove(disk,config,move,visible,async()=>{},skeleton));
	assert.equal(await read(first,'note.md'),manual+'\nnew edit');
	await fs.writeFile(await file(first,'note.md'),manual);
	await executeMove(disk,config,move,visible,async()=>{},skeleton);
	let moved=(await discover(disk,config)).find(l=>l.identity?.id===first.identity.id);
	assert.equal(moved.location,move.destination);
	assert.equal(await read(moved,category),secondCategory);
	assert.ok((await read(moved,pageTemplate)).includes(first.location));
	assert.equal(await read(moved,'note.md'),manual.replace(first.location,moved.location));
	const filters=parseDocument(await read(moved,bookBase)).getIn(['filters','and']).toJSON();
	assert.ok(filters.some(filter=>filter.includes(first.location)));
	assert.ok(filters.includes('file.name == "My books"'));
	assert.deepEqual(await fs.readFile(path.join(await disk.path(moved.location),'.git/index')),stage);
	assert.equal(await read(second,category),secondCategory);
	// The old Kepano protocol explicitly owned this dashboard and offered to restore it.
	const raw=parseToml(await read(moved,'kb.toml'));
	raw.manager.managed=[{path:bookBase,role:'kepano-bindings',root:moved.location,fingerprint:digest(await read(moved,bookBase))}];
	await fs.writeFile(await file(moved,'kb.toml'),stringifyToml(raw));
	moved=(await discover(disk,config)).find(l=>l.identity?.id===first.identity.id);
	await fs.unlink(await file(moved,bookBase));
	const report=await examine(disk,moved,skeleton);
	const repair=report.repairs.find(r=>r.file===bookBase);
	assert.equal(repair.before,null);
	await fs.writeFile(await file(moved,bookBase),'newer user Base');
	await assert.rejects(applyRepair(disk,config,moved,repair,visible,skeleton));
	assert.equal(await read(moved,bookBase),'newer user Base');
	await fs.unlink(await file(moved,bookBase));
	await applyRepair(disk,config,moved,repair,visible,skeleton);
	assert.ok((await read(moved,bookBase)).includes(moved.location));
});
