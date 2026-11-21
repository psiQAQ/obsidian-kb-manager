import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {initializeRepository} from '../src/git/repository.ts';
import {GraphHistory, HistoryLanes, snapshotHistory} from '../src/git/history-graph.ts';
import {history} from '../src/git/versions.ts';
import {committedComparison} from '../src/git/index-history.ts';

test('fixed branch tips preserve every merge lane across pages and isolate historical comparisons',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const dir=await fs.mkdtemp(path.resolve('.tmp','commit-graph-'));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	await initializeRepository(dir);
	const git=(args,input)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',input,windowsHide:true}).trimEnd();
	git(['config','user.name','Research Team']);git(['config','user.email','team@example.invalid']);
	const tree=content=>{
		const blob=git(['hash-object','-w','--stdin'],content);
		return git(['mktree'],'100644 blob '+blob+'\tnote.md\n');
	};
	const firstTree=tree('base\n'),secondTree=tree('side\n'),mergedTree=tree('merged\n');
	const commit=(value,parents,message)=>git(['commit-tree',value,...parents.flatMap(p=>['-p',p]),'-m',message]);
	const base=commit(firstTree,[],'start\n\nSearchable body on last page');
	let left=base,right=base;
	for(let i=0;i<22;i++){
		left=commit(firstTree,[left],'main '+i);
		right=commit(secondTree,[right],'side '+i);
	}
	const merge=commit(mergedTree,[left,right],'join branches');
	const local=commit(firstTree,[base],'unmerged local'),remote=commit(secondTree,[base],'remote only');
	git(['update-ref','refs/heads/main',merge]);git(['update-ref','refs/heads/topic',local]);
	git(['update-ref','refs/remotes/origin/remote-only',remote]);
	for(const all of [false,true]){
		const snapshot=await snapshotHistory(dir,all);
		assert.deepEqual(new Set(snapshot.tips),new Set(all?[merge,local,remote]:[merge]));
		const expected=git(['rev-list','--topo-order',...snapshot.tips]).split('\n');
		const graph=new GraphHistory(dir,snapshot);
		await graph.load(21);
		assert.equal(graph.rows.length,21);
		await Promise.all([graph.load(33),graph.load(50)]);
		assert.deepEqual(graph.rows.map(row=>row.commit.oid),expected);
		assert.equal(graph.rows.at(-1).commit.message.trimEnd(),'start\n\nSearchable body on last page');
		const layout=new HistoryLanes();
		assert.deepEqual(graph.rows,graph.rows.map(row=>layout.append(row.commit)));
		assert.equal(graph.rows.find(row=>row.commit.oid===merge).parents.length,2);
		assert(snapshot.labels.get(merge).includes('HEAD · main'));
	}
	const first=await history(dir,undefined,20);
	git(['update-ref','refs/heads/main',local]);
	const page2=await history(dir,first.next,20),page3=await history(dir,page2.next,20);
	assert.deepEqual([...first.entries,...page2.entries,...page3.entries].map(c=>c.oid),git(['rev-list','--topo-order',merge]).split('\n'));
	assert.equal(page3.next,undefined);
	const a=await committedComparison(dir,merge,'note.md'),b=await committedComparison(dir,merge,'note.md',right);
	assert.equal(a.parent,left);assert.equal(a.before.toString(),'base\n');assert.equal(b.before.toString(),'side\n');
	assert.equal(a.after.toString(),b.after.toString());assert.equal(b.parent,right);
	await assert.rejects(committedComparison(dir,merge,'note.md',base),/parent|父提交/u);
});
