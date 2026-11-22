import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../src/fs/vault.ts';
import { discover, newIdentity, writeIdentity } from '../src/kb/catalog.ts';
import { executeMove, planMove } from '../src/kb/move.ts';
import { referenceEdit } from '../src/kb/move-references.ts';
import { registerVaultLibrary } from '../src/registry/discovery.ts';
import { vaultDisk } from './fixtures/vault-disk.mjs';

test('move selected references, refuse stale or read-only sources, and resume after a partial rewrite', async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','move-references-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const config={parents:[],templates:[]}, disk=vaultDisk(root,'.settings');
	const source='Source', destination='Dest/Moved';
	const manifest={};
	for (const folder of [source,'Peer']) {
		manifest[folder]=newIdentity(folder,'',{id:'personal',version:'1'});
		await fs.mkdir(path.join(root,folder));
		await fs.writeFile(path.join(root,folder,'kb.toml'),writeIdentity('',manifest[folder]));
		await registerVaultLibrary(disk,config,folder);
	}
	const original={
		'Source/Main.md':'# Heading\r\n\r\n[Peer](../Peer/Peer.md#^block "title")\r\n',
		'Source/Map.canvas':'{"nodes":[{"type":"file","file":"Source/Main.md"},{"type":"file","file":"Source/Absent.md"},{"type":"text","text":"Source/Main.md"}],"edges":[]}\n',
		'Peer/Peer.md':'[[Source/Main#Heading|Alias]]\n',
		'Peer/Unselected.md':'![[Source/Image.png|80]]\n',
		'Inbox.md':'[[Source/Main#Heading]]\n',
	};
	const save=(file,text)=>fs.writeFile(path.join(root,file),text);
	const read=file=>fs.readFile(path.join(root,file),'utf8');
	await fs.mkdir(path.join(root,'Dest'));
	await save('Source/Image.png',Buffer.from([137,80,78,71]));
	for (const [file,text] of Object.entries(original)) await save(file,text);
	const libraries=await discover(disk,config);
	const moving=libraries.find(library=>library.location===source);
	const peer=libraries.find(library=>library.location==='Peer');
	const plan=await planMove(disk,config,moving,'Dest','Moved',{});
	const ref=(file,owner,originalLink,target)=>referenceEdit(file,owner,original[file],plan,{
		kind:'markdown',tokens:[{offset:original[file].indexOf(originalLink),original:originalLink,target}],
	});
	plan.references=[
		ref('Source/Main.md',moving,'[Peer](../Peer/Peer.md#^block "title")','Peer/Peer.md'),
		referenceEdit('Source/Map.canvas',moving,original['Source/Map.canvas'],plan,{kind:'canvas',targets:['Source/Main.md']}),
		ref('Peer/Peer.md',peer,'[[Source/Main#Heading|Alias]]','Source/Main.md'),
	];
	assert(plan.references.every(edit=>!('after' in edit)));
	let current=plan, interrupted=false, renamed=0;
	const writes=[];
	const files={
		async renameFolder(from,to) {
			assert.equal(from,source);assert.equal(to,destination);
			await fs.rename(path.join(root,from),path.join(root,to));
			renamed++;
		},
		async replace(file,before,after) {
			assert.equal(digest(await read(file)),before);
			if (interrupted && file==='Peer/Peer.md') throw Error('interrupted between reference writes');
			await save(file,after);
			writes.push(file);
		},
	};
	const run=()=>executeMove(disk,config,current,files,async value=>{ current=structuredClone(value); });

	await save('Peer/Peer.md',original['Peer/Peer.md']+'external edit\n');
	await assert.rejects(run(),/变化|changed/u);
	await save('Peer/Peer.md',original['Peer/Peer.md']);
	await save('Peer/kb.toml',writeIdentity('',{...manifest.Peer,archived:true}));
	await assert.rejects(run(),/安全写入|safely/u);
	await save('Peer/kb.toml',writeIdentity('',{...manifest.Peer,id:moving.identity.id}));
	await assert.rejects(run(),/重复|uplicate/u);
	await save('Peer/kb.toml',writeIdentity('',manifest.Peer));
	await fs.mkdir(path.join(root,destination));
	await assert.rejects(run(),/冲突|onflicting/u);
	await fs.rmdir(path.join(root,destination));
	assert.equal(renamed,0);
	assert.deepEqual(writes,[]);
	assert.equal(current.phase,'prepared');

	interrupted=true;
	await assert.rejects(run(),/interrupted/u);
	assert.equal(current.phase,'moved');
	assert.equal(renamed,1);
	assert.deepEqual(writes,[destination+'/Main.md',destination+'/Map.canvas']);
	assert.equal(await read('Peer/Peer.md'),original['Peer/Peer.md']);
	await save('Peer/Peer.md',original['Peer/Peer.md']+'intervening edit\n');
	await assert.rejects(run(),/变化|changed/u);
	await save('Peer/Peer.md',original['Peer/Peer.md']);
	interrupted=false;
	await run();
	assert.equal(current.phase,'complete');
	assert.equal(renamed,1);
	assert.deepEqual(writes,[destination+'/Main.md',destination+'/Map.canvas','Peer/Peer.md']);
	assert.equal(await read(destination+'/Main.md'),original['Source/Main.md'].replace('../Peer','../../Peer'));
	assert.equal(await read(destination+'/Map.canvas'),original['Source/Map.canvas'].replace('"file":"Source/Main.md"','"file":"Dest/Moved/Main.md"'));
	assert.equal(await read('Peer/Peer.md'),'[[Dest/Moved/Main#Heading|Alias]]\n');
	assert.equal(await read('Peer/Unselected.md'),original['Peer/Unselected.md']);
	assert.equal(await read('Inbox.md'),original['Inbox.md']);
	assert.deepEqual((await discover(disk,config)).map(library=>library.location),[destination,'Peer']);
});
