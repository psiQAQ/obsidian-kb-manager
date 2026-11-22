import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {initializeRepository} from '../src/git/repository.ts';
import {GraphHistory, HistoryLanes, historyRefKey, historyTips, historyTrackColors, historyWorktree, snapshotHistory} from '../src/git/history-graph.ts';
import {history} from '../src/git/versions.ts';
import {committedComparison} from '../src/git/index-history.ts';
import {historyWindow,historyRowHeight} from '../src/ui/history-window.ts';

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
	git(['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/remote-only']);
	const tagged=commit(firstTree,[base],'tag-only commit');
	git(['tag','-m','old release','release',tagged]);
	git(['tag','also-main',merge]);
	git(['tag','non-commit',firstTree]);
	for(const all of [false,true]){
		const snapshot=await snapshotHistory(dir,all);
		assert.deepEqual(new Set(snapshot.tips),new Set(all?[merge,local,remote,tagged]:[merge]));
		assert.deepEqual(historyTips(snapshot,['refs/heads/topic','refs/tags/release']),[local,tagged]);
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
		assert.deepEqual(snapshot.labels.get(merge).map(({kind,name})=>[kind,name]),
			[['head','HEAD'],['local','main'],['tag','also-main']]);
		assert.deepEqual(snapshot.labels.get(tagged),[{kind:'tag',name:'release',ref:'refs/tags/release',oid:tagged,
			tagOid:git(['rev-parse','refs/tags/release'])}]);
		assert(!snapshot.refs.some(ref=>ref.name==='origin/HEAD' || ref.name==='non-commit'));
		assert(graph.children.get(left).includes(merge));
		assert(graph.children.get(right).includes(merge));
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

	git(['reset','--hard',merge]);
	await fs.writeFile(path.join(dir,'note.md'),'staged\n');git(['add','note.md']);
	await fs.writeFile(path.join(dir,'note.md'),'later working edit\n');
	await fs.writeFile(path.join(dir,'untracked.md'),'untracked\n');
	const bytes=await fs.readFile(path.join(dir,'.git','index'));
	assert.deepEqual(await historyWorktree(dir),{staged:1,unstaged:2});
	assert.deepEqual(await fs.readFile(path.join(dir,'.git','index')),bytes);
	assert.equal(git(['rev-parse','HEAD']),merge);
	git(['stash','push','--include-untracked','-m','one']);
	await fs.writeFile(path.join(dir,'note.md'),'second stash\n');
	git(['stash','push','-m','two']);
	const snapshot=await snapshotHistory(dir),stashes=snapshot.refs.filter(ref=>ref.kind==='stash');
	assert.deepEqual(stashes.map(({name,oid})=>[name,oid]),[['stash@{0}',git(['rev-parse','stash@{0}'])],['stash@{1}',git(['rev-parse','stash@{1}'])]]);
	assert.deepEqual(historyTips(snapshot,'current',true),[merge,...stashes.map(ref=>ref.oid)]);
	assert.deepEqual(historyTips(snapshot,['refs/heads/topic'],true),[local]);
	assert.deepEqual(historyTips(snapshot,[historyRefKey(stashes[1])],true),[stashes[1].oid]);
	assert.equal(await historyWorktree(dir),undefined);
	const graph=new GraphHistory(dir,snapshot,true);
	assert.equal(graph.workingRow.commit.oid,'worktree');
	await graph.load(1);
	assert.equal(graph.rows[0].commit.oid,merge);
	assert.equal(graph.rows[0].incoming,true);
});

test('deep history retains native topological order and a bounded rendered window',async t=>{
	await fs.mkdir('.tmp',{recursive:true});
	const root=path.resolve('.tmp');
	const dir=await fs.mkdtemp(path.join(root,'deep-graph-'));
	assert(dir.startsWith(root+path.sep));
	t.after(()=>fs.rm(dir,{recursive:true,force:true}));
	await initializeRepository(dir);
	const git=(args,input)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',input,windowsHide:true}).trimEnd();
	const total=1536;
	const commits=Array.from({length:total},(_,index)=>[
		'commit refs/heads/main','committer Graph Fixture <graph@example.invalid> '+(1577836800+index)+' +0000',
		'data '+String(index).length,String(index),'',
	].join('\n')).join('\n');
	git(['fast-import','--quiet'],commits);
	const graph=new GraphHistory(dir,await snapshotHistory(dir));
	await graph.load(140);
	await Promise.all([graph.load(310),graph.load(total+1)]);
	assert.deepEqual(graph.rows.map(row=>row.commit.oid),git(['rev-list','--topo-order','HEAD']).split('\n'));
	assert.equal(graph.rows.at(-1).commit.message.trim(),'0');
	assert.equal(graph.complete,true);
	const {start,end}=historyWindow(1400*historyRowHeight,16*historyRowHeight,graph.rows.length);
	assert.deepEqual([start,end],[1390,1426]);
	assert.deepEqual(historyWindow(0,10*historyRowHeight,3),{start:0,end:3});

	const interrupted=new GraphHistory(dir,graph.snapshot);
	await interrupted.load(140);
	let active=true;
	const pending=interrupted.load(total+1,()=>active);
	active=false;
	await pending;
	assert.equal(interrupted.rows.length,940,'only the already running page finishes after cancellation');
	assert.equal(interrupted.complete,false);
	await interrupted.load(1100);
	assert.deepEqual(interrupted.rows,graph.rows.slice(0,1100));
});

test('active history lanes keep distinct palette slots and preserve each continuing rail color',()=>{
	const layout=new HistoryLanes();
	const append=(oid,parents=[])=>layout.append({oid,parents,author:'',timestamp:0,message:''});
	const parents=Array.from({length:historyTrackColors},(_,i)=>'branch-'+i);
	const first=append('merge',parents);
	assert.equal(new Set(first.parents.map(rail=>rail.color%historyTrackColors)).size,historyTrackColors);

	const released=append(parents[3]);
	const replacement=append('unrelated',['another-parent']);
	assert.equal(replacement.color%historyTrackColors,released.color%historyTrackColors);
	assert.notEqual(replacement.color,released.color);
	assert.deepEqual(replacement.rails.map(rail=>rail.color),released.rails.map(rail=>rail.color));
});
