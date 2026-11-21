import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {advancedPreview,applyAdvanced} from '../src/git/history-advanced.ts';
import {hostingLinks} from '../src/git/hosting-links.ts';
import {guardGit} from '../src/git/guard.ts';
import {initializeRepository} from '../src/git/repository.ts';

async function fixture(t){
	const root=path.resolve('.tmp');
	await fs.mkdir(root,{recursive:true});
	const dir=await fs.mkdtemp(path.join(root,'graph-action-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:120}));
	await initializeRepository(dir);
	const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true}).trimEnd();
	git('config','user.name','Graph Testing');git('config','user.email','graph@example.invalid');
	const write=(name,text)=>fs.writeFile(path.join(dir,name),text);
	const commit=(message)=>{git('add','-A');git('commit','-qm',message);return git('rev-parse','HEAD');};
	await write('.gitignore','kb.toml\n.log/\n');await write('kb.toml','local manifest\n');await write('note.md','base\n');
	const base=commit('base');await write('note.md','revised\n');const tip=commit('edit');
	const execute=async req=>applyAdvanced(dir,await advancedPreview(dir,req));
	return {dir,git,write,commit,base,tip,execute};
}

test('graph previews bind bytes, keep local management files and restore only the selected path',async t=>{
	const {dir,git,write,base,tip,execute}=await fixture(t);
	await write('unused.md','v1');const clean=await advancedPreview(dir,{action:'clean'});
	assert.deepEqual(clean.paths,['unused.md']);
	await write('unused.md','v2');await assert.rejects(applyAdvanced(dir,clean));
	await execute({action:'clean'});assert.equal(await fs.readFile(path.join(dir,'kb.toml'),'utf8'),'local manifest\n');
	await assert.rejects(advancedPreview(dir,{action:'restore',oid:base,file:'kb.toml'}));
	await execute({action:'restore',oid:base,file:'note.md'});assert.equal(git('show',':note.md'),'base');
	assert.equal(git('rev-parse','HEAD'),tip);
	await execute({action:'hard',oid:tip});assert.equal(git('status','--porcelain'),'');
	await execute({action:'soft',oid:base});assert.equal(git('rev-parse','HEAD'),base);assert.equal(git('show',':note.md'),'revised');
	await execute({action:'mixed',oid:tip});assert.equal(git('status','--porcelain'),'');
	await execute({action:'detach',oid:base});assert.equal(await guardGit(dir,new Set(),true),'HEAD');await assert.rejects(guardGit(dir));
	await execute({action:'attach',oid:tip,ref:'refs/heads/main'});assert.equal(git('branch','--show-current'),'main');
});

test('graph operations preview paths and recover a conflicting cherry-pick',async t=>{
	const {dir,git,write,commit,base,tip,execute}=await fixture(t);
	git('switch','-qc','topic',base);await write('note.md','topic\n');const topic=commit('topic');
	git('switch','-q','main');
	const pick=await advancedPreview(dir,{action:'cherry-pick',oid:topic,ref:'refs/heads/topic'});
	assert.deepEqual(pick.paths,['note.md']);await assert.rejects(applyAdvanced(dir,pick));
	await assert.rejects(advancedPreview(dir,{action:'continue'}));await execute({action:'abort'});
	assert.equal(git('rev-parse','HEAD'),tip);assert.equal(git('status','--porcelain'),'');
	await assert.rejects(execute({action:'cherry-pick',oid:topic}));
	await write('note.md','resolved\n');await execute({action:'resolve',file:'note.md'});await execute({action:'continue'});
	assert.equal(git('show','HEAD:note.md'),'resolved');
	const selected=git('rev-parse','HEAD');await execute({action:'revert',oid:selected});
	assert.equal(git('show','HEAD:note.md'),'revised');
	await execute({action:'drop',oid:git('rev-parse','HEAD')});assert.equal(git('rev-parse','HEAD'),selected);
});

test('hosting links stay with the bound provider and encode branch and issue references',()=>{
	const urls=hostingLinks('git@github.com:example/notes.git','topic/plan','Link #42 and #42');
	assert.deepEqual(urls.map(link=>link.url),['https://github.com/example/notes/compare/topic%2Fplan?expand=1','https://github.com/example/notes/issues/42']);
	assert.deepEqual(hostingLinks('https://example.invalid/a/b','main'),[]);
});

test('graph recovery resumes a conflicted rebase after reopening a detached history',async t=>{
	const {dir,git,write,commit,base,execute}=await fixture(t);
	git('switch','-qc','topic',base);await write('note.md','topic\n');commit('topic');
	assert.throws(()=>git('rebase','main'));
	assert.equal(await guardGit(dir,new Set(),true),'HEAD');
	await write('note.md','combined\n');await execute({action:'resolve',file:'note.md'});
	await execute({action:'continue'});assert.equal(git('branch','--show-current'),'topic');
	assert.equal(git('show','HEAD:note.md'),'combined');
});
