import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {initializeRepository} from '../src/git/repository.ts';
import {previewVersion,saveVersion} from '../src/git/versions.ts';
import {squash,squashPreview} from '../src/git/squash.ts';

test('squashing keeps the original tip reachable, keeps its tree and checks the preview',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const dir=await fs.mkdtemp(path.resolve('.tmp/squash-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
	const author={name:'Fixture',email:'author@example.invalid'};
	await initializeRepository(dir);
	const heads=[];
	for(const text of ['base','first','second']){
		await fs.writeFile(path.join(dir,'note.md'),text);
		heads.push(await saveVersion(dir,await previewVersion(dir),text,author));
	}
	const plan=await squashPreview(dir,heads[0]);
	await fs.writeFile(path.join(dir,'extra'),'untracked');
	await assert.rejects(squash(dir,plan,'combined',author));
	await fs.unlink(path.join(dir,'extra'));
	const oid=await squash(dir,plan,'combined',author);
	assert.equal(git('rev-parse','HEAD'),oid);
	assert.equal(git('rev-parse','HEAD^'),heads[0]);
	assert.equal(git('rev-parse','HEAD^{tree}'),git('rev-parse',heads[2]+'^{tree}'));
	assert.equal(git('rev-parse','refs/kb-manager/before-squash/'+heads[2]),heads[2]);
	assert.equal(git('status','--porcelain'),'');
});
