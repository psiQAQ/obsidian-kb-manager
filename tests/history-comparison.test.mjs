import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import {compareHistory,compareHistoryFile,currentHistoryPath,historyTextLimit,readHistorySnapshot} from '../src/git/index-history.ts';
import {readHistoryCommit} from '../src/git/history-graph.ts';
import {initializeRepository} from '../src/git/repository.ts';
import {markdownAttributes} from '../src/git/markdown-attributes.ts';

const commit=oid=>({kind:'commit',oid});
const empty={kind:'empty'},working={kind:'working'};
const rows=files=>files.map(file=>[file.status,file.before?.file,file.after?.file]);

test('diverged revisions and empty trees compare in the requested direction, including renames',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const dir=await fs.mkdtemp(path.resolve('.tmp','graph-compare-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	const native=(...args)=>execFileSync('git',['-C',dir,...args]).toString().trim();
	const write=(file,text)=>fs.writeFile(path.join(dir,file),text);
	await initializeRepository(dir);
	native('config','user.name','Test');native('config','user.email','test@example.invalid');
	await write('base.md','base');native('add','.');native('commit','-qm','base');
	const base=native('rev-parse','HEAD');
	const initial=await compareHistory(dir,empty,commit(base));
	assert.deepEqual(rows(initial),[['A',undefined,'base.md']]);
	assert.deepEqual(initial[0].lineCounts,{additions:1,deletions:0});
	assert.deepEqual(rows(await compareHistory(dir,commit(base),empty)),[['D','base.md',undefined]]);
	native('branch','first');native('switch','-q','first');
	await write('旧版.md','same first line\nsame second line\nkeep these lines\nlast line\n');native('add','.');native('commit','-qm','first');
	const first=native('rev-parse','HEAD');
	native('switch','-q','main');
	await write('新版.md','same first line\nsame second line\nkeep these lines\nchange last\nextra\n');native('add','.');native('commit','-qm','second');
	const second=native('rev-parse','HEAD');
	const forward=await compareHistory(dir,commit(first),commit(second)),reverse=await compareHistory(dir,commit(second),commit(first));
	assert.deepEqual(rows(forward),[['R','旧版.md','新版.md']]);
	assert.deepEqual(forward[0].lineCounts,{additions:2,deletions:1});
	assert.deepEqual(rows(reverse),[['R','新版.md','旧版.md']]);
	assert.deepEqual(reverse[0].lineCounts,{additions:1,deletions:2});
	const comparison=await compareHistoryFile(dir,commit(first),commit(second),'新版.md','旧版.md');
	assert.match(comparison.before.bytes.toString(),/last line/);
	assert.match(comparison.after.bytes.toString(),/change last/);
	assert.deepEqual(await readHistorySnapshot(dir,first,'旧版.md'),comparison.before);
	await assert.rejects(readHistorySnapshot(dir,first,'../outside.md'),/Invalid history file path/);
	await write('large.bin',Buffer.alloc(historyTextLimit+1));
	native('add','large.bin');native('commit','-qm','large');
	assert.deepEqual(await readHistorySnapshot(dir,native('rev-parse','HEAD'),'large.bin'),{size:historyTextLimit+1,bytes:undefined});
	await write('large-working.bin',Buffer.alloc(historyTextLimit+1));
	assert.deepEqual((await compareHistoryFile(dir,empty,working,'large-working.bin')).after,{size:historyTextLimit+1});
});

test('commit details retain recorded identities and complete messages, and numstat handles literal special paths',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const dir=await fs.mkdtemp(path.resolve('.tmp','graph-details-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	const run=(args,input,env={})=>execFileSync('git',['-C',dir,...args],{input,env:{...process.env,...env}}).toString().trim();
	await initializeRepository(dir);
	run(['config','user.name','Configured user']);run(['config','user.email','configured@example.invalid']);
	const filename='name\twith\nline breaks.md';
	// Create historical names directly in the tree, including ones Windows cannot check out.
	const tree=(markdown,binary)=>{
		const entries=[[filename,markdown],['binary.bin',Buffer.from(binary)]];
		const input=entries.map(([file,bytes])=>'100644 blob '+run(['hash-object','-w','--stdin'],bytes)+'\t'+file+'\0').join('');
		return run(['mktree','-z'],input);
	};
	const base=run(['commit-tree',tree('old first\nkeep\n',[0,1,2]),'-m','base']);
	const message='改动标题\n\n完整正文。\n\n最后一段。\n';
	const next=run(['commit-tree',tree('new first\nkeep\nnew last\n',[0,1,3]),'-p',base,'-F','-'],message,{
		GIT_AUTHOR_NAME:'Original Author',GIT_AUTHOR_EMAIL:'author@example.invalid',GIT_AUTHOR_DATE:'2026-11-22T08:00:01+08:00',
		GIT_COMMITTER_NAME:'Actual Committer',GIT_COMMITTER_EMAIL:'committer@example.invalid',GIT_COMMITTER_DATE:'2026-11-21T19:30:03-05:00',
	});
	run(['update-ref','HEAD',next]);
	const info=await readHistoryCommit(dir,next);
	assert.deepEqual(info.parent,[base]);
	assert.deepEqual(info.author,{name:'Original Author',email:'author@example.invalid',timestamp:Date.parse('2026-11-22T00:00:01Z')/1000,offset:'+0800'});
	assert.deepEqual(info.committer,{name:'Actual Committer',email:'committer@example.invalid',timestamp:Date.parse('2026-11-22T00:30:03Z')/1000,offset:'-0500'});
	assert.equal(info.message,message);
	const files=await compareHistory(dir,commit(base),commit(next));
	assert.deepEqual(files.map(file=>[file.file,file.status,file.lineCounts]),[
		['binary.bin','M',undefined],[filename,'M',{additions:2,deletions:1}],
	]);
	const compared=await compareHistoryFile(dir,commit(base),commit(next),filename);
	assert.equal(compared.before.bytes.toString(),'old first\nkeep\n');
	assert.equal(compared.after.bytes.toString(),'new first\nkeep\nnew last\n');
});

test('current note follows committed and uncommitted moves without opening a reused name',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const dir=await fs.mkdtemp(path.resolve('.tmp','graph-note-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	const native=(...args)=>execFileSync('git',['-C',dir,...args]).toString().trim();
	const write=(file,text)=>fs.writeFile(path.join(dir,file),text);
	const rename=(from,to)=>fs.rename(path.join(dir,from),path.join(dir,to));
	const snapshot=message=>{native('add','-A');native('commit','-qm',message);return native('rev-parse','HEAD');};
	await initializeRepository(dir);
	native('config','user.name','Test');native('config','user.email','test@example.invalid');native('config','core.autocrlf','false');
	await write('.gitattributes',markdownAttributes);
	await write('old.md','original short note\n');
	await write('deleted.md','will be removed\n');
	await write('ambiguous.md','will have two successors\n');
	await write('copied.md','original text\nlast line\n');
	const origin=snapshot('add notes');
	native('switch','-qc','unmerged');
	await write('old.md','change the note on an unrelated branch\n');
	const unmerged=snapshot('unmerged change');
	native('switch','-q','main');
	await rename('old.md','moved.md');
	await write('old.md','unrelated replacement under the old name\n');
	await fs.unlink(path.join(dir,'deleted.md'));
	snapshot('rename and reuse the old path in one commit');
	native('commit','--allow-empty','-qm','empty commit');
	await write('deleted.md','new note with the same name\n');
	const reused=snapshot('add another note under a deleted name');
	assert.equal(await currentHistoryPath(dir,origin,'old.md'),'moved.md');
	assert.equal(await currentHistoryPath(dir,origin,'deleted.md'),undefined);
	assert.equal(await currentHistoryPath(dir,unmerged,'old.md'),undefined);
	assert.equal(await currentHistoryPath(dir,reused,'old.md'),'old.md');
	await rename('moved.md','current.md');
	await write('current.md','original short note\r\n');
	await write('moved.md','second unrelated replacement\n');
	assert.equal(await currentHistoryPath(dir,origin,'old.md'),'current.md');
	await rename('ambiguous.md','candidate-a.md');
	await fs.copyFile(path.join(dir,'candidate-a.md'),path.join(dir,'candidate-b.md'));
	assert.equal(await currentHistoryPath(dir,origin,'ambiguous.md'),undefined);
	const committedAmbiguous=snapshot('two identical move candidates');
	assert.equal(await currentHistoryPath(dir,origin,'ambiguous.md'),undefined);
	assert.equal(await currentHistoryPath(dir,committedAmbiguous,'candidate-b.md'),'candidate-b.md');
	await fs.copyFile(path.join(dir,'copied.md'),path.join(dir,'copy.md'));
	assert.equal(await currentHistoryPath(dir,origin,'copied.md'),'copied.md');
	await write('copied.md','original text\nnew last line\n');
	assert.equal(await currentHistoryPath(dir,origin,'copied.md'),undefined);
	snapshot('copy a note while editing the same path');
	assert.equal(await currentHistoryPath(dir,origin,'copied.md'),undefined);
	native('switch','-qc','merged');
	await rename('current.md','merged-note.md');
	const merged=snapshot('move the note on a branch');
	native('switch','-q','main');
	await write('main.md','independent main branch note\n');
	snapshot('unrelated main change');
	native('merge','--no-ff','-qm','merge tracked note','merged');
	assert.equal(await currentHistoryPath(dir,origin,'old.md'),'merged-note.md');
	assert.equal(await currentHistoryPath(dir,merged,'merged-note.md'),'merged-note.md');
});

test('working tree combines staged, partial and untracked changes without changing HEAD or the index',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const dir=await fs.mkdtemp(path.resolve('.tmp','graph-working-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	const native=(...args)=>execFileSync('git',['-C',dir,...args]).toString().trim();
	const write=(file,text)=>fs.writeFile(path.join(dir,file),text);
	await initializeRepository(dir);
	native('config','user.name','Test');native('config','user.email','test@example.invalid');
	await write('.gitignore','ignored.md\n');
	await write('partial.md','base');
	await write('removed.md','will disappear');
	await write('renamed.md','exact rename');
	await write('recreated.md','before removal');
	await write('cancelled.md','original on disk');
	native('add','.');native('commit','-qm','base');
	const head=native('rev-parse','HEAD');
	await write('partial.md','in index');native('add','partial.md');
	await write('partial.md','on disk\nextra\n');
	await write('cancelled.md','different in index');native('add','cancelled.md');
	await write('cancelled.md','original on disk');
	await write('vanished.md','exists only in index');native('add','vanished.md');
	await fs.unlink(path.join(dir,'vanished.md'));
	native('rm','-q','removed.md');
	native('rm','--cached','-q','recreated.md');await write('recreated.md','recreated\nsecond\nthird\n');
	await fs.rename(path.join(dir,'renamed.md'),path.join(dir,'new-name.md'));
	await write('untracked.md','untracked');await write('ignored.md','ignored');
	const index=await fs.readFile(path.join(dir,'.git','index'));
	const objects=()=>fs.readdir(path.join(dir,'.git','objects'),{recursive:true}).then(entries=>entries.sort());
	const initialObjects=await objects();
	const files=await compareHistory(dir,commit(head),working);
	assert.deepEqual(rows(files),[
		['R','renamed.md','new-name.md'],['M','partial.md','partial.md'],['M','recreated.md','recreated.md'],
		['D','removed.md',undefined],['A',undefined,'untracked.md'],
	]);
	const counts=(entries,name)=>entries.find(file=>file.file===name)?.lineCounts;
	assert.deepEqual(counts(files,'partial.md'),{additions:2,deletions:1});
	assert.deepEqual(counts(files,'recreated.md'),{additions:3,deletions:1});
	const contents=await compareHistoryFile(dir,commit(head),working,'partial.md');
	assert.equal(contents.before.bytes.toString(),'base');
	assert.equal(contents.after.bytes.toString(),'on disk\nextra\n');
	assert.equal(native('show',':partial.md'),'in index');
	const reversed=await compareHistory(dir,working,commit(head));
	assert.ok(rows(reversed).some(row=>JSON.stringify(row)===JSON.stringify(['R','new-name.md','renamed.md'])));
	assert.ok(rows(reversed).some(row=>JSON.stringify(row)===JSON.stringify(['D','untracked.md',undefined])));
	assert.deepEqual(counts(reversed,'partial.md'),{additions:1,deletions:2});
	assert.deepEqual(counts(reversed,'recreated.md'),{additions:1,deletions:3});
	assert.ok(rows(await compareHistory(dir,empty,working)).some(row=>JSON.stringify(row)===JSON.stringify(['A',undefined,'untracked.md'])));
	assert.equal(native('rev-parse','HEAD'),head);
	assert.deepEqual(await fs.readFile(path.join(dir,'.git','index')),index);
	assert.deepEqual(await objects(),initialObjects);
});
