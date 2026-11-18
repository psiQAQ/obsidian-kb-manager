import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {ageColor,displayAuthor,lineCredits,parseLineCredits} from '../src/git/authorship.ts';
import {gitDefaults,renderCommitMessage} from '../src/preferences.ts';
import {initializeRepository} from '../src/git/repository.ts';

test('blame metadata formats author, age and uncommitted lines', () => {
	const oid = 'ab'.repeat(20);
	const fields = 'author Jane Doe\nauthor-time 100\nauthor-tz -0230\nsummary Initial work\n';
	const credits = parseLineCredits(oid+' 1 2\n'+fields+'\told\n'+'0'.repeat(40)+' 2 3\n'+fields+'\tnew\n');
	assert.deepEqual(credits,[{line:2,oid,author:'Jane Doe',timestamp:100,offset:'-0230',summary:'Initial work'}]);
	assert.equal(displayAuthor('Jane Doe','initials'),'JD');
	assert.equal(ageColor(credits[0],gitDefaults,100000),'rgb(255,150,150)');
	assert.equal(ageColor(credits[0],gitDefaults,100000+365*86400000),'rgb(66,220,255)');
	assert.equal(renderCommitMessage({commitMessage:'{{date}} {{hostname}} {{numFiles}} {{files}}',commitHostname:'desk'},
		'2026-11-19','ignored',['A.md','B.md']),'2026-11-19 desk 2 A.md, B.md');
});

test('native blame uses editor text and the selected library in a nested vault',async t => {
	await fs.mkdir('.tmp',{recursive:true});
	const vault = await fs.mkdtemp(path.resolve('.tmp','blame-'));
	t.after(() => fs.rm(vault,{recursive:true,force:true}));
	const run = (dir,...args) => execFileSync('git',['-C',dir,...args],{encoding:'utf8'});
	const roots = [vault,path.join(vault,'A'),path.join(vault,'B')];
	for (const [i,dir] of roots.entries()) {
		await fs.mkdir(dir,{recursive:true});
		await initializeRepository(dir);
		await fs.writeFile(path.join(dir,'note.md'),'one\ntwo\n');
		run(dir,'add','--','note.md');
		run(dir,'-c','user.name=Author '+i,'-c','user.email=local@example.invalid','commit','-qm','Initial');
	}
	const savedHeads = roots.map(dir => run(dir,'rev-parse','HEAD'));
	for (const [i,dir] of roots.entries()) {
		if (!i) continue;
		const credits = await lineCredits(dir,'note.md',1,3,'local insert\none\ntwo\n',gitDefaults);
		assert.deepEqual(credits.map(c => [c.line,c.author]),[[2,'Author '+i],[3,'Author '+i]]);
		await assert.rejects(lineCredits(dir,'../note.md',1,1,'',gitDefaults),/file/);
	}
	assert.deepEqual(roots.map(dir => run(dir,'rev-parse','HEAD')),savedHeads);
});
