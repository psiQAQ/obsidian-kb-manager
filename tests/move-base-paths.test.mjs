import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from '../src/fs/vault.ts';
import { discover, newIdentity, writeIdentity, writeTemplateFileRecord } from '../src/kb/catalog.ts';
import { moveBaseFields } from '../src/kb/move-base-paths.ts';
import { referenceEdit } from '../src/kb/move-references.ts';
import { executeMove, planMove } from '../src/kb/move.ts';
import { registerVaultLibrary } from '../src/registry/discovery.ts';
import { vaultDisk } from './fixtures/vault-disk.mjs';

test('offer only scoped Base path literals and identify expressions for review',()=>{
	const text=[
		'filters:',
		'  and:',
		'    - file.inFolder("Source")',
		'    - this.file.path.startsWith("Source/Child")',
		'    - file.inFolder("SourceSibling")',
		'    - file.path.startsWith("Source")',
		'    - file.folder == "Source"',
		'    - \'file.inFolder("Source/" + note.category)\'',
		'    - file.inFolder("Source/../Peer")',
		'    - file.inFolder("/Source")',
		'    - file.inFolder("source")',
		'    - \'file.inFolder("Source/Note") && file.path.contains("Source/Partial")\'',
		'views:',
		'  - name: Source',
		'    type: table',
		'    filters: this.file.inFolder("Source/Child") # preserved comment',
	].join('\r\n');
	const scope={source:'Source',destination:'Dest/Moved'};
	const result=moveBaseFields(text,'Outside.base',scope,false);
	assert.deepEqual(result.fields.map(({field,before,after})=>[field,before,after]),[
		['filters.and[0]','Source','Dest/Moved'],
		['filters.and[1]','Source/Child','Dest/Moved/Child'],
		['filters.and[9]','Source/Note','Dest/Moved/Note'],
		['views[0].filters','Source/Child','Dest/Moved/Child'],
	]);
	assert.equal(result.manual.length,7);
	assert(result.manual.every(line=>!line.includes('SourceSibling')));
	assert.equal(moveBaseFields(text,'Outside.base',scope,true).fields.length,0);
	const punctuation={source:'Source',destination:'Dest/Folder #tag, [ref]'};
	const quoted=moveBaseFields('filters: \'file.inFolder("Source")\'\n','Outside.base',punctuation,false);
	assert.equal(quoted.fields[0].replacement,'"Dest/Folder #tag, [ref]"');
	const plain=moveBaseFields('filters: file.inFolder("Source")\n','Outside.base',punctuation,false);
	assert.equal(plain.fields.length,0);
	assert.equal(plain.manual.length,1);
	const flow='filters: {and: [file.inFolder("Source")]}\n';
	assert.equal(moveBaseFields(flow,'Outside.base',scope,false).fields.length,1);
	const comma=moveBaseFields(flow,'Outside.base',{source:'Source',destination:'Dest/Moved, here'},false);
	assert.equal(comma.fields.length,0);
	assert.equal(comma.manual.length,1);
	const alias='filters:\n  and:\n    - &original file.inFolder("Source")\n    - *original\n';
	const shared=moveBaseFields(alias,'Outside.base',scope,false);
	assert.equal(shared.fields.length,0);
	assert.equal(shared.manual.length,2);
});

test('hide only Base path reviews proved by the exact managed field update',()=>{
	const scope={source:'Source',destination:'Dest/Moved'};
	const text=[
		'filters:',
		'  and:',
		'    - file.inFolder("Source/Courses")',
		'    - file.inFolder("Source/Notes") && file.inFolder("Source/Extras")',
		'    - file.path.contains("Source/dynamic")',
		'    - file.path.startsWith("Source")',
	].join('\n');
	const after=text.replace('Source/Courses','Dest/Moved/Courses')
		.replace('Source/Notes','Dest/Moved/Notes').replace('startsWith("Source")','startsWith("Dest/Moved")');
	const preview=moveBaseFields(text,'Source/Managed.base',scope,true,after);
	assert.deepEqual(preview.fields,[]);
	assert.equal(preview.manual.length,3);
	assert(preview.manual.some(line=>line.includes('Source/Extras')));
	assert(preview.manual.some(line=>line.includes('Source/dynamic')));
	assert(preview.manual.some(line=>line.includes('startsWith("Source")')));
	const changedPredicate=after.replace('file.inFolder("Dest/Moved/Courses")','!file.inFolder("Dest/Moved/Courses")');
	assert(moveBaseFields(text,'Source/Managed.base',scope,true,changedPredicate).manual
		.some(line=>line.includes('Source/Courses')));
	assert(moveBaseFields(text,'Source/Managed.base',scope,true,after.replace('Dest/Moved/Courses','Dest/Moved/Sibling')).manual
		.some(line=>line.includes('Source/Courses')));
});

test('preserve unselected Base fields, combine checked literals with Markdown links, and resume recovery',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','move-base-paths-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk=vaultDisk(root,'.settings'), config={parents:[],templates:[]};
	const scope={source:'Source',destination:'Dest/Moved'};
	const md='\uFEFF[[Source/Target|a link]]\r\n\r\n```base\r\nfilters:\r\n  and:\r\n'+
		'    - file.inFolder("Source") # preserve\r\n    - file.path.startsWith("Source/")\r\n```\r\n';
	const standalone='filters: this.file.inFolder(\'Source\')\r\n';
	const excluded='filters: file.inFolder("Source")\n';
	const sourceIdentity=newIdentity('Source','',{id:'personal',version:'1'});
	sourceIdentity.managed.push({path:'Protected.base',role:'overview-bindings',root:'Source',fingerprint:digest(excluded)});
	const peerIdentity=newIdentity('Peer','',{id:'personal',version:'1'});
	const save=(file,text)=>fs.writeFile(path.join(root,file),text);
	const read=file=>fs.readFile(path.join(root,file),'utf8');
	for(const directory of ['Source','Peer','Dest']) await fs.mkdir(path.join(root,directory));
	await save('Source/kb.toml',writeTemplateFileRecord(writeIdentity('',sourceIdentity),{version:'1',digests:{'Template.base':digest(excluded)}}));
	await save('Peer/kb.toml',writeIdentity('',peerIdentity));
	await registerVaultLibrary(disk,config,'Source');
	await registerVaultLibrary(disk,config,'Peer');
	await save('Source/Mixed.md',md);
	await save('Source/Template.base',excluded);
	await save('Source/Protected.base',excluded);
	await save('Source/Target.md','# Target\n');
	await save('Peer/Selected.base',standalone);
	await save('Peer/Unselected.base',excluded);

	const libraries=await discover(disk,config);
	const moving=libraries.find(library=>library.location===scope.source);
	const peer=libraries.find(library=>library.location==='Peer');
	const plan=await planMove(disk,config,moving,'Dest','Moved',{});
	const beforeLink='[[Source/Target|a link]]';
	const baseEdit=(file,owner,text)=>referenceEdit(file,owner,text,scope,{
		kind:'base',base:[moveBaseFields(text,file,scope,false).fields[0].token],
	});
	plan.references=[
		referenceEdit('Source/Mixed.md',moving,md,scope,{
			kind:'markdown',tokens:[{offset:md.indexOf(beforeLink),original:beforeLink,target:'Source/Target.md'}],
			base:[moveBaseFields(md,'Source/Mixed.md',scope,false).fields[0].token],
		}),
		baseEdit('Source/Template.base',moving,excluded),
		baseEdit('Peer/Selected.base',peer,standalone),
	];
	let recovery=plan, renamed=0, interrupted=false;
	const writes=[];
	const files={
		async renameFolder(from,to){
			await fs.rename(path.join(root,from),path.join(root,to));
			renamed++;
		},
		async replace(file,before,after){
			assert.equal(digest(await read(file)),before);
			if (interrupted && file==='Peer/Selected.base') throw Error('interrupted between Base writes');
			await save(file,after);
			writes.push(file);
		},
	};
	const run=()=>executeMove(disk,config,recovery,files,async value=>{recovery=JSON.parse(JSON.stringify(value));});

	recovery={...plan,references:[...plan.references,baseEdit('Source/Protected.base',moving,excluded)]};
	await assert.rejects(run(),/Invalid|无效/u);
	recovery=plan;
	await save('Peer/Selected.base',standalone+'# later edit\n');
	await assert.rejects(run(),/changed|变化/u);
	await save('Peer/Selected.base',standalone);
	assert.equal(renamed,0);

	interrupted=true;
	await assert.rejects(run(),/interrupted between Base writes/u);
	assert.equal(recovery.phase,'moved');
	assert.deepEqual(writes,['Dest/Moved/Mixed.md','Dest/Moved/Template.base']);
	interrupted=false;
	await run();
	assert.equal(recovery.phase,'complete');
	assert.equal(renamed,1);
	assert.deepEqual(writes,['Dest/Moved/Mixed.md','Dest/Moved/Template.base','Peer/Selected.base']);
	assert.equal(await read('Dest/Moved/Mixed.md'),md.replace(beforeLink,'[[Dest/Moved/Target|a link]]')
		.replace('file.inFolder("Source")','file.inFolder("Dest/Moved")'));
	assert.equal(await read('Dest/Moved/Protected.base'),excluded);
	assert.equal(await read('Dest/Moved/Template.base'),excluded.replace('Source','Dest/Moved'));
	assert.equal(await read('Peer/Selected.base'),standalone.replace('Source','Dest/Moved'));
	assert.equal(await read('Peer/Unselected.base'),excluded);
});
