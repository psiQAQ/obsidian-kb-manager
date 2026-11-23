import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../src/fs/vault.ts';
import { discover, newIdentity, parseIdentity, writeIdentity } from '../src/kb/catalog.ts';
import { executeMove, planMove } from '../src/kb/move.ts';
import { ambiguousWikiMoveTargets, managedReferenceDisposition, referenceEdit } from '../src/kb/move-references.ts';
import { canvasFileFields } from '../src/kb/move-link-text.ts';
import { keepsRelativeLinkTarget, moveProperties, movePropertyTokens, moveReferenceDefinition, moveReferenceUse } from '../src/kb/move-markdown-paths.ts';
import { rootPatches } from '../src/kb/path-binding-slots.ts';
import { registerVaultLibrary } from '../src/registry/discovery.ts';
import { vaultDisk } from './fixtures/vault-disk.mjs';

test('require review for affected short or suffix wikilinks with multiple targets',()=>{
	let snapshots=0;
	const lookup=ambiguousWikiMoveTargets(()=>{
		snapshots++;
		return ['Alpha/Notes/Detail.md','Beta/Notes/Detail.md','Nested/Alpha/Notes/Detail.md','Alpha/Only.md',
			'Other/Picture.svg','Beta/Picture.svg'];
	});
	const scope={source:'Alpha',destination:'Moved'};
	const candidates=['Alpha/Notes/Detail.md','Beta/Notes/Detail.md','Nested/Alpha/Notes/Detail.md'];
	assert.deepEqual(lookup('Start.md','Detail','Alpha/Notes/Detail.md',scope),candidates);
	assert.deepEqual(lookup('Start.md','Notes/Detail','Beta/Notes/Detail.md',scope),candidates);
	assert.deepEqual(lookup('Beta/Start.md','Notes/Detail.md',undefined,scope),candidates);
	assert.deepEqual(lookup('Start.md','Alpha/Notes/Detail','Alpha/Notes/Detail.md',scope),[]);
	assert.deepEqual(lookup('Start.md','/Alpha/Notes/Detail','Alpha/Notes/Detail.md',scope),[]);
	assert.deepEqual(lookup('Alpha/Start.md','./Notes/Detail','Alpha/Notes/Detail.md',scope),[]);
	assert.deepEqual(lookup('Beta/Start.md','../Alpha/Notes/Detail','Alpha/Notes/Detail.md',scope),[]);
	assert.deepEqual(lookup('Start.md','Only','Alpha/Only.md',scope),[]);
	assert.deepEqual(lookup('Start.md','Picture.svg','Beta/Picture.svg',scope),[]);
	assert.deepEqual(lookup('Alpha/Start.md','Picture.svg','Beta/Picture.svg',scope),['Beta/Picture.svg','Other/Picture.svg']);
	assert.equal(snapshots,1);
});

test('prove saved property and reference links keep their target after the move',()=>{
	const scope={source:'Old/Library',destination:'Elsewhere/Nested/Library'};
	const from='Old/Library/Notes/From.md', target='Old/Library/Related/Note.md';
	assert(keepsRelativeLinkTarget('../Related/Note',from,target,scope));
	assert(keepsRelativeLinkTarget('../QA/Target','Old/Library/QA/Stable.md','Old/Library/QA/Target.md',scope));
	assert(!keepsRelativeLinkTarget('../Related/Note',from,'Elsewhere/Related/Note.md',scope));
	assert(!keepsRelativeLinkTarget('../../Peer/Note',from,'Old/Peer/Note.md',scope));
	assert(!keepsRelativeLinkTarget('Note',from,target,scope));
	const original='[[Old/Library/Related/Note#Heading|Label]]';
	const text='---\r\nrelated:\r\n  - "'+original+'"\r\n  - "[[../Related/Note]]"\r\n---\r\n';
	const before=moveProperties(text);
	assert.equal(before.get('related.0').value,original);
	assert.deepEqual(movePropertyTokens(before,'related.0',original,target),[
		{offset:text.indexOf(original),original,target,property:{key:'related.0',link:original}},
	]);
	assert.deepEqual(movePropertyTokens(before,'related.1',original,target),[]);
	const lines=['[Description][The Label]', '[The Label]: <../Related/A%20B.md#Heading> "Title"'];
	const position={start:{line:1,col:0,offset:24},end:{line:1,col:57,offset:81}};
	assert.equal(moveReferenceDefinition(lines,'the label',position,'../Related/A B.md#Heading'),
		'[The Label]: <../Related/A%20B.md#Heading>');
	assert.equal(moveReferenceDefinition(lines,'the label',position,'../Other/A B.md#Heading'),undefined);
	assert.equal(moveReferenceUse(lines[0],'Description'),'the label');
});

test('only suppress managed overlaps whose exact reference will be updated',()=>{
	const scope={source:'Old/Library',destination:'Elsewhere/Library'};
	const file='Old/Library/From.md';
	const first='[[Old/Library/First#Topic|Label]]', second='![[Old/Library/List.base#Tab]]';
	const text='# Links\r\n'+first+' · '+second+'\r\n';
	const patch=original=>({offset:text.indexOf(original),original,replacement:original.replace(scope.source,scope.destination)});
	const start=text.indexOf(scope.source);
	const managed={file,patches:[{start,end:start+scope.source.length,replacement:scope.destination}]};
	assert.equal(managedReferenceDisposition(patch(first),managed),'covered');
	assert.equal(managedReferenceDisposition(patch(second),managed),'ordinary');
	assert.equal(managedReferenceDisposition({...patch(first),replacement:first.replace('#Topic','#Other')},managed),'review');
});

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
		'Source/Map.canvas':'{"nodes":[{"type":"file","id":"selected","file":"Source/Main.md"},{"type":"file","id":"leave","file":"Source/Main.md"},{"type":"file","file":"Source/Absent.md"},{"type":"text","text":"Source/Main.md"}],"edges":[]}\n',
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
		referenceEdit('Source/Map.canvas',moving,original['Source/Map.canvas'],plan,{kind:'canvas-fields',
			tokens:[canvasFileFields(original['Source/Map.canvas']).find(field=>field.id==='selected').token]}),
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

test('merge selected property and reference definition edits with a declared opaque slot and resume after another write fails',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','move-mixed-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk=vaultDisk(root,'.settings'),config={parents:[],templates:[]};
	const source='Source',destination='Dest/Longer Library';
	const file='Source/Mixed.md';
	const property='[[Source/Target#Heading|label]]';
	const definition='[label]: </Source/Target.md#Heading>';
	const untouched='[[Source/Target|unchecked]]';
	const opaque='Source/target-for-script';
	const text='\uFEFF---\r\nrelated: [\''+property+'\', \''+untouched+'\'] # keep\r\n---\r\n'+
		'[Read][label]\r\n'+definition+' "title"\r\n```js\r\nconst path = "'+opaque+'";\r\n```\r\n';
	const manifest=newIdentity(source,'',{id:'personal',version:'1'});
	const offset=text.indexOf(opaque);
	manifest.managed.push({path:'Mixed.md',role:'template-root',root:source,offsets:[text.indexOf(property)+2,offset-source.length],fingerprint:digest(text)});
	const save=(pathName,value)=>fs.writeFile(path.join(root,pathName),value);
	const read=pathName=>fs.readFile(path.join(root,pathName),'utf8');
	for (const folder of ['Source','Dest','Outside']) await fs.mkdir(path.join(root,folder));
	await save('Source/kb.toml',writeIdentity('',manifest));
	await registerVaultLibrary(disk,config,source);
	await save(file,text);
	await save('Source/Target.md','# Heading\n');
	const external='[[Source/Target]]\n';
	await save('Outside/Other.md',external);
	const [moving]=await discover(disk,config);
	const plan=await planMove(disk,config,moving,'Dest','Longer Library',{});
	const change=plan.changes.find(item=>item.file==='Mixed.md');
	assert.deepEqual(change.patches,[{start:offset,end:offset+source.length,replacement:destination}]);
	plan.references=[
		referenceEdit(file,moving,text,plan,{kind:'markdown',tokens:[
			...movePropertyTokens(moveProperties(text),'related.0',property,'Source/Target.md'),
			{offset:text.indexOf(definition),original:definition,target:'Source/Target.md',definition:true},
		]},change),
		referenceEdit('Outside/Other.md',undefined,external,plan,{kind:'markdown',tokens:[
			{offset:0,original:external.trim(),target:'Source/Target.md'},
		]}),
	];
	let recovery=plan,interrupted=true;
	const writes=[];
	const files={
		async replace(file,before,after){
			assert.equal(digest(await read(file)),before);
			if(interrupted && file==='Outside/Other.md')throw Error('interrupted external write');
			await save(file,after);writes.push(file);
		},
	};
	const run=()=>executeMove(disk,config,recovery,files,async record=>{recovery=structuredClone(record);});
	const movedPath=destination+'/Mixed.md';
	await assert.rejects(run(),/interrupted external write/u);
	assert.equal(recovery.phase,'moved');
	assert.deepEqual(writes,[movedPath]);
	const expected=text.replace(property,property.replace(source,destination)).replace(definition,definition.replace(source,'Dest/Longer%20Library'))
		.replace(opaque,opaque.replace(source,destination));
	assert.equal(await read(movedPath),expected);
	assert.equal(parseIdentity(await read(destination+'/kb.toml')).managed[0].root,source);
	await save(movedPath,expected+'new external edit');
	await assert.rejects(run(),/编辑|edited/u);
	await save(movedPath,expected);
	interrupted=false;
	await run();
	assert.equal(recovery.phase,'complete');
	assert.deepEqual(writes,[movedPath,'Outside/Other.md']);
	const [binding]=parseIdentity(await read(destination+'/kb.toml')).managed;
	assert.equal(binding.fingerprint,digest(expected));
	assert.deepEqual(rootPatches(expected,binding.offsets,destination,'Next',binding.path),[
		{start:expected.indexOf(opaque.replace(source,destination)),end:expected.indexOf('/target-for-script'),replacement:'Next'},
	]);
});
