import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeRepository } from '../src/git/repository.ts';
import { createGraphBranch, createGraphTag, deleteGraphTag, graphRemoteTarget, graphTagDetails,
	renameGraphBranch, trackGraphBranch } from '../src/git/graph-ref-actions.ts';
import { applyGraphStash, graphStashPlan, graphStashSavePlan, saveGraphStash } from '../src/git/graph-stash-actions.ts';

async function repository(t){
	await fs.mkdir('.tmp',{recursive:true});
	const dir=await fs.mkdtemp(path.resolve('.tmp','graph-ref-actions-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	await initializeRepository(dir);
	const git=(...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',windowsHide:true}).trimEnd();
	const write=(file,content)=>fs.writeFile(path.join(dir,file),content);
	git('config','user.name','Notebook Tester');git('config','user.email','notebooks@example.invalid');
	git('config','core.autocrlf','false');
	await write('note.md','first\n');git('add','note.md');git('commit','-m','first');
	const first=git('rev-parse','HEAD');
	await write('note.md','second\n');git('add','note.md');git('commit','-m','second');
	return {dir,git,write,first,head:git('rev-parse','HEAD')};
}

test('graph refs use selected commits, preserve tracking metadata, and reject stale refs',async t=>{
	const {dir,git,first,head}=await repository(t);
	await createGraphBranch(dir,'notes/topic',first);
	assert.equal(git('rev-parse','refs/heads/notes/topic'),first);
	assert.equal(git('rev-parse','HEAD'),head);
	await assert.rejects(createGraphBranch(dir,'notes/topic',head));
	await assert.rejects(renameGraphBranch(dir,'refs/heads/notes/topic',head,'moved'),/changed|变化/u);
	await renameGraphBranch(dir,'refs/heads/notes/topic',first,'notes/moved');
	assert.equal(git('rev-parse','refs/heads/notes/moved'),first);
	git('remote','add','origin','https://example.invalid/notebooks.git');
	git('update-ref','refs/remotes/origin/archive/topic',first);
	const target=await graphRemoteTarget(dir,'origin','archive/topic');
	assert.equal(target.fetchDisplay,'https://example.invalid/notebooks.git');
	await trackGraphBranch(dir,'refs/remotes/origin/archive/topic',first,'origin','notes/tracked');
	assert.equal(git('rev-parse','notes/tracked'),first);
	assert.equal(git('rev-parse','notes/tracked@{upstream}'),first);
	assert.equal(git('config','branch.notes/tracked.merge'),'refs/heads/archive/topic');
});

test('graph tags preserve annotation and cannot overwrite or delete a later tag',async t=>{
	const {dir,git,first,head}=await repository(t);
	await createGraphTag(dir,'v-draft',first,'');
	await assert.rejects(createGraphTag(dir,'v-draft',head,''));
	const light={ref:'refs/tags/v-draft',oid:first};
	assert.equal(await graphTagDetails(dir,light),undefined);
	const identity={name:'Notebook Tester',email:'notebooks@example.invalid'};
	await createGraphTag(dir,'v-reviewed',first,'Approved\n\nWith notes',identity);
	const annotated={ref:'refs/tags/v-reviewed',oid:first,tagOid:git('rev-parse','refs/tags/v-reviewed')};
	assert.notEqual(annotated.tagOid,first);
	const details=await graphTagDetails(dir,annotated);
	assert.match(details.tagger,/Notebook Tester <notebooks@example.invalid>/u);
	assert.equal(details.message,'Approved\n\nWith notes');
	git('update-ref',light.ref,head);
	await assert.rejects(deleteGraphTag(dir,light),/changed|变化/u);
	assert.equal(git('rev-parse',light.ref),head);
	await deleteGraphTag(dir,annotated);
	assert.equal(git('tag','--list'),'v-draft');
});

test('stash actions preserve partial staging, isolate untracked files and recheck selectors',async t=>{
	const {dir,git,write,head}=await repository(t);
	await write('note.md','staged\n');git('add','note.md');await write('note.md','working\n');
	await write('新笔记.md','untracked\n');
	const preview=await graphStashSavePlan(dir,true);
	assert.deepEqual(new Set(preview.files),new Set(['note.md','新笔记.md']));
	await saveGraphStash(dir,preview,'partial stage');
	assert.equal(git('status','--porcelain'),'');
	const stash={ref:'stash@{0}',oid:git('rev-parse','stash@{0}')};
	const applied=await graphStashPlan(dir,stash,'apply');
	await applyGraphStash(dir,applied);
	assert.equal(git('show',':note.md'),'staged');
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'working\n');
	assert.equal(await fs.readFile(path.join(dir,'新笔记.md'),'utf8'),'untracked\n');
	assert.equal(git('rev-parse','stash@{0}'),stash.oid);
	assert.equal(git('rev-parse','HEAD'),head);
	await saveGraphStash(dir,await graphStashSavePlan(dir,true),'second stash');
	await assert.rejects(graphStashPlan(dir,stash,'drop'),/changed|变化/u);
	const newer={ref:'stash@{0}',oid:git('rev-parse','stash@{0}')};
	await applyGraphStash(dir,await graphStashPlan(dir,newer,'pop'));
	assert.equal(git('rev-parse','stash@{0}'),stash.oid);
	assert.equal(git('show',':note.md'),'staged');
});

test('stash branch restores its original base and retains the stash',async t=>{
	const {dir,git,write,head}=await repository(t);
	await write('note.md','stash contents\n');
	await saveGraphStash(dir,await graphStashSavePlan(dir,false),'restore here');
	const stash={ref:'stash@{0}',oid:git('rev-parse','stash@{0}')};
	await write('second.md','separate commit\n');git('add','second.md');git('commit','-m','advance main');
	await applyGraphStash(dir,await graphStashPlan(dir,stash,'branch'),'restored-work');
	assert.equal(git('branch','--show-current'),'restored-work');
	assert.equal(git('rev-parse','HEAD'),head);
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'stash contents\n');
	assert.equal(git('rev-parse','stash@{0}'),stash.oid);
	await write('kb.toml','local manifest\n');
	await assert.rejects(graphStashSavePlan(dir,true),/manifest|清单/u);
});

test('stash rejects overlapping edits and leaves the selected stash and clean index intact',async t=>{
	const {dir,git,write}=await repository(t);
	await write('note.md','stash contents\n');
	const old=await graphStashSavePlan(dir,false);
	await write('note.md','latest stash contents\n');
	await assert.rejects(saveGraphStash(dir,old,'stale preview'),/changed|变化/u);
	await saveGraphStash(dir,await graphStashSavePlan(dir,false),'save this');
	const stash={ref:'stash@{0}',oid:git('rev-parse','stash@{0}')};
	await write('note.md','conflicting commit\n');git('add','note.md');git('commit','-m','overlap');
	await assert.rejects(graphStashPlan(dir,stash,'pop'),/overlap|重叠/u);
	assert.equal(git('show',':note.md'),'conflicting commit');
	assert.equal(git('status','--porcelain'),'');
	assert.equal(git('rev-parse','stash@{0}'),stash.oid);
});
