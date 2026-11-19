import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {initializeRepository} from '../src/git/repository.ts';
import {applyChange,bindRemote,changePlan,createBranch,remoteState,transfer} from '../src/git/network.ts';
import {blameLine} from '../src/git/network-native.ts';
import {clearUndo,finishMerge,inspectMerge,markResolved,undoInfo} from '../src/git/network-merge.ts';
import {readGrants,AutomationClock,selectPaths} from '../src/git/network-automation.ts';
import {deletionPlan,removeBranch,remoteRemoval,removeRemote,serverBranches,trackBranch} from '../src/git/network-refs.ts';
import {previewVersion,saveVersion} from '../src/git/versions.ts';

const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
async function fixture(t){
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','network-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	git(root,'init','--quiet');
	const dir=path.join(root,'A'),bare=path.join(root,'remote.git');
	await fs.mkdir(dir);await initializeRepository(dir);
	git(dir,'config','user.name','Tester');git(dir,'config','user.email','test@example.invalid');
	await fs.writeFile(path.join(dir,'kb-manager.json'),'identity');await fs.writeFile(path.join(dir,'note.md'),'one\n');
	git(dir,'add','.');git(dir,'commit','-qm','first');
	git(root,'init','--bare','--quiet','--initial-branch=main',bare);git(bare,'config','http.receivepack','true');
	const backend=createServer(async(req,res)=>{
		try{
			const chunks=[];for await(const chunk of req)chunks.push(chunk);
			const url=new URL(req.url,'http://localhost');
			const out=execFileSync('git',['http-backend'],{cwd:root,input:Buffer.concat(chunks),env:{...process.env,
				GIT_PROJECT_ROOT:root,GIT_HTTP_EXPORT_ALL:'1',PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),
				REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']??'',REMOTE_USER:'tester'}});
			const at=out.indexOf('\r\n\r\n');
			for(const line of out.subarray(0,at).toString().split('\r\n')){
				const split=line.indexOf(':');
				const key=line.slice(0,split),val=line.slice(split+1).trim();
				if(key.toLowerCase()==='status')res.statusCode=Number.parseInt(val);
				else res.setHeader(key,val);
			}
			res.end(out.subarray(at+4));
		}catch(error){res.statusCode=500;res.end(String(error));}
	});
	await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
	t.after(()=>new Promise(resolve=>backend.close(resolve)));
	const url='http://127.0.0.1:'+backend.address().port+'/remote.git';
	await bindRemote(dir,'main','origin',url,'main');
	return {root,dir,bare,target:(await remoteState(dir)).target};
}

for(const backend of ['native','builtin'])test(backend+' Git operations address only the selected nested repository',async t=>{
	const {root,dir,bare,target}=await fixture(t);
	const index=path.join(root,'.git','index');
	const parentBranch=git(root,'symbolic-ref','HEAD');
	await transfer(dir,'push',target,backend);
	assert.equal(git(bare,'rev-parse','refs/heads/main'),git(dir,'rev-parse','HEAD'));
	const peer=path.join(root,'B');
	git(root,'clone','--quiet','--branch','main',bare,peer);
	await fs.writeFile(path.join(peer,'note.md'),'two\n');
	git(peer,'add','note.md');git(peer,'-c','user.name=Peer','-c','user.email=peer@example.invalid','commit','-qm','second');git(peer,'push','-q','origin','main');
	await transfer(dir,'fetch',target,backend);
	const plan=await changePlan(dir,'refs/remotes/origin/main');
	assert.deepEqual(plan.changes,['note.md']);
	await applyChange(dir,plan,'pull',backend,'ff-only');
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'two\n');
	assert.equal(git(dir,'rev-parse','HEAD'),git(peer,'rev-parse','HEAD'));
	await createBranch(dir,'topic');
	await applyChange(dir,await changePlan(dir,'refs/heads/topic'),'switch',backend,'ff-only');
	assert.equal(git(dir,'branch','--show-current'),'topic');
	if(backend==='native')assert.equal((await blameLine(dir,'note.md',1)).author,'Peer');
	await fs.writeFile(path.join(dir,'note.md'),'staged');git(dir,'add','note.md');await fs.writeFile(path.join(dir,'note.md'),'worktree');
	await assert.rejects(changePlan(dir,'refs/heads/main'),/store all changes/);
	assert.equal(git(dir,'show',':note.md'),'staged');
	assert.equal(git(root,'symbolic-ref','HEAD'),parentBranch);
	await assert.rejects(fs.stat(index),{code:'ENOENT'});
	assert.equal(await fs.readFile(path.join(peer,'note.md'),'utf8'),'two\n');
});
test('merge resolution stages only the confirmed blob and preserves a partially staged sibling',async t=>{
	const {dir}=await fixture(t);
	git(dir,'switch','-qc','side');
	await fs.writeFile(path.join(dir,'note.md'),'theirs');git(dir,'add','note.md');git(dir,'commit','-qm','side');
	git(dir,'switch','-q','main');await fs.writeFile(path.join(dir,'note.md'),'ours');git(dir,'add','note.md');git(dir,'commit','-qm','main');
	assert.throws(()=>git(dir,'merge','side'));
	await fs.writeFile(path.join(dir,'other.md'),'staged');git(dir,'add','other.md');await fs.writeFile(path.join(dir,'other.md'),'unstaged');
	const partial=git(dir,'rev-parse',':other.md');
	const old=await inspectMerge(dir);
	assert.deepEqual(old.conflicts.map(x=>[x.file,x.stages.map(s=>s.stage)]),[['note.md',[1,2,3]]]);
	await fs.writeFile(path.join(dir,'note.md'),'resolution');
	await assert.rejects(markResolved(dir,old,'note.md'));
	await markResolved(dir,await inspectMerge(dir),'note.md');
	assert.equal(git(dir,'show',':note.md'),'resolution');
	assert.equal(git(dir,'rev-parse',':other.md'),partial);
	await fs.writeFile(path.join(dir,'note.md'),'after resolution');
	const ready=await inspectMerge(dir);
	assert.equal(ready.conflicts.length,0);
	await finishMerge(dir,ready,'finish');
	assert.equal(git(dir,'rev-parse','HEAD^1'),ready.head);
	assert.equal(git(dir,'rev-parse','HEAD^2'),ready.other);
	assert.equal(git(dir,'show','HEAD:other.md'),'staged');
	assert.equal(await fs.readFile(path.join(dir,'other.md'),'utf8'),'unstaged');
	assert.equal(git(dir,'show','HEAD:note.md'),'resolution');
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'after resolution');
	const undo=await undoInfo(dir);
	assert.ok(undo.entries.some(item=>item.endsWith('\tnote.md')));
	await clearUndo(dir,undo);
	assert.equal(git(dir,'rev-parse',':other.md'),partial);
	await remoteState(dir);
});

test('automation grants use independent clocks and reset after reauthorization',()=>{
	const id='12345678-1234-1234-1234-123456789abc';
	const grant={location:'kb/A',branch:'main',remote:'',url:'',remoteBranch:'',backend:'builtin',commit:1,pull:0,push:5,
		autoGlobMode:'exclude',autoGlobs:'',autoAfterEdits:false,autoFromLastCommit:false,autoPullOnStart:false};
	const clocks=new AutomationClock();
	assert.deepEqual(readGrants({[id]:grant}),{[id]:grant});
	assert.deepEqual(readGrants({[id]:{...grant,commit:-1}}),{});
	assert.deepEqual(clocks.due(grant,0),[]);
	assert.deepEqual(clocks.due(grant,60000),['commit']);
	clocks.completed(grant,'commit',60000);
	assert.deepEqual(clocks.due(grant,60001),[]);
	assert.deepEqual(clocks.due(grant,300000),['commit','push']);
	assert.deepEqual(clocks.due({...grant},300000),[]);
	grant.paused='conflict';
	assert.deepEqual(clocks.due(grant,600000),[]);
});

test('edit debounce, recent commit and startup pull use only the authorized schedule',()=>{
	const clock=new AutomationClock();
	const grant={commit:2,pull:0,push:0,autoAfterEdits:true,autoFromLastCommit:true,autoPullOnStart:true};
	assert.deepEqual(clock.due(grant,500000,0,true),['pull']);
	clock.edited(grant,501000);
	clock.edited(grant,530000);
	assert.deepEqual(clock.due(grant,649999,0),[]);
	assert.deepEqual(clock.due(grant,650000,0),['commit']);
	clock.completed(grant,'commit',650000);
	assert.deepEqual(clock.due(grant,1000000,0),[]);
	assert.deepEqual(clock.due({...grant,autoAfterEdits:false},500000,0),['commit']);
});

test('automatic commit uses exactly the authorized glob selection and stops for a partial index',async t=>{
	const {dir}=await fixture(t);
	git(dir,'config','user.name','Auto');git(dir,'config','user.email','auto@example.invalid');
	await fs.mkdir(path.join(dir,'wiki'));
	await fs.writeFile(path.join(dir,'wiki','a.md'),'yes');await fs.writeFile(path.join(dir,'private.md'),'no');
	const preview=await previewVersion(dir);
	const files=preview.changes.map(c=>c.file);
	assert.deepEqual(selectPaths('exclude','private.md',files),['wiki/a.md']);
	assert.deepEqual(selectPaths('include','',files),[]);
	const selected=new Set(selectPaths('include','wiki/',files));
	await saveVersion(dir,preview,'selected',undefined,'smart',selected);
	assert.equal(git(dir,'show','-s','--format=%an <%ae>'),'Auto <auto@example.invalid>');
	assert.equal(git(dir,'show','HEAD:wiki/a.md'),'yes');
	assert.ok(!git(dir,'ls-tree','--name-only','HEAD').includes('private.md'));
	git(dir,'add','private.md');await fs.writeFile(path.join(dir,'private.md'),'different');
	await assert.rejects(saveVersion(dir,await previewVersion(dir),'bad',undefined,'smart',new Set(['private.md'])));
	assert.equal(git(dir,'show',':private.md'),'no');
});

test('managed refs refuse unmerged deletion and track a selected advertised remote branch',async t=>{
	const {dir,bare,target}=await fixture(t);
	await transfer(dir,'push',target,'builtin');
	git(bare,'branch','upstream-topic','main');
	const branches=await serverBranches(dir,target);
	const remoteTopic=branches.find(b=>b.name==='upstream-topic');
	assert.ok(remoteTopic);
	await trackBranch(dir,target,remoteTopic,'local-topic');
	assert.equal(git(dir,'rev-parse','local-topic'),remoteTopic.oid);
	assert.equal(git(dir,'config','branch.local-topic.merge'),'refs/heads/upstream-topic');
	assert.equal(git(dir,'branch','--show-current'),'main');
	await removeBranch(dir,await deletionPlan(dir,'local-topic'));
	assert.ok(!git(dir,'branch','--list','local-topic'));
	git(dir,'switch','-qc','unmerged');
	await fs.writeFile(path.join(dir,'extra'),'extra');git(dir,'add','extra');git(dir,'commit','-qm','unmerged');
	git(dir,'switch','-q','main');
	await assert.rejects(deletionPlan(dir,'unmerged'));
	const plan=await remoteRemoval(dir,'origin');assert.deepEqual(plan.affected,['main']);
	await removeRemote(dir,plan);
	assert.equal(git(dir,'remote'),'');
	assert.equal(git(dir,'rev-parse','refs/remotes/origin/upstream-topic'),remoteTopic.oid);
	assert.equal(git(bare,'rev-parse','main'),target && remoteTopic.oid);
});
test('manual native merge applies the previewed conflict strategy with two parents',async t=>{
	const {dir}=await fixture(t);
	git(dir,'switch','-qc','side');
	await fs.writeFile(path.join(dir,'note.md'),'right');git(dir,'add','note.md');git(dir,'commit','-qm','right');
	const side=git(dir,'rev-parse','HEAD');
	git(dir,'switch','-q','main');await fs.writeFile(path.join(dir,'note.md'),'left');git(dir,'add','note.md');git(dir,'commit','-qm','left');
	const before=git(dir,'rev-parse','HEAD');
	git(dir,'config','--unset','user.name');git(dir,'config','--unset','user.email');
	const plan=await changePlan(dir,'refs/heads/side');
	await assert.rejects(applyChange(dir,plan,'pull','native','merge','theirs'),/user\.name/u);
	git(dir,'config','user.name','Library author');git(dir,'config','user.email','library@example.invalid');
	await applyChange(dir,await changePlan(dir,'refs/heads/side'),'pull','native','merge','theirs');
	assert.equal(git(dir,'rev-parse','HEAD^1'),before);
	assert.equal(git(dir,'rev-parse','HEAD^2'),side);
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'right');
	assert.equal(git(dir,'log','-1','--format=%an <%ae>'),'Library author <library@example.invalid>');
});

test('rebase preserves the original author and uses this repository’s committer',async t=>{
	const {dir}=await fixture(t);
	git(dir,'switch','-qc','side');
	await fs.writeFile(path.join(dir,'side.md'),'incoming');
	git(dir,'add','side.md');git(dir,'commit','-qm','side');
	git(dir,'switch','-q','main');
	await fs.writeFile(path.join(dir,'main.md'),'outgoing');
	git(dir,'add','main.md');git(dir,'commit','-qm','main');
	git(dir,'config','user.name','Rebaser');git(dir,'config','user.email','rebaser@example.invalid');
	await applyChange(dir,await changePlan(dir,'refs/heads/side'),'pull','native','rebase');
	assert.equal(git(dir,'show','-s','--format=%an/%cn <%ce>'),'Tester/Rebaser <rebaser@example.invalid>');
});




test('clone inspects a remote library before publishing and preserves a competing destination',async t=>{
	const {downloadLibrary}=await import('../src/kb/clone.ts');
	const {defaults,newIdentity}=await import('../src/kb/catalog.ts');
	const {VaultDisk}=await import('../src/fs/vault.ts');
	const {root,dir,target}=await fixture(t);
	await fs.writeFile(path.join(dir,'kb-manager.json'),JSON.stringify(newIdentity('Research','',{id:'custom',version:'1'})));
	git(dir,'add','kb-manager.json');git(dir,'commit','-qm','bind identity');
	await transfer(dir,'push',target,'builtin');
	const disk=new VaultDisk(root,'.vault-settings'), input={parent:defaults.parents[0],name:'Imported',url:target.url};
	const clone=await downloadLibrary(disk,defaults,input);
	assert.ok(clone.files.includes('note.md'));
	const destination=path.join(root,input.parent,input.name);
	await fs.mkdir(destination);
	await assert.rejects(clone.publish(defaults),/exists|已存在/);
	await fs.rmdir(destination);
	await clone.publish(defaults);
	assert.equal(git(destination,'rev-parse','HEAD'),git(dir,'rev-parse','HEAD'));
	const duplicate=await downloadLibrary(disk,defaults,{...input,name:'Copy'});
	await assert.rejects(duplicate.publish(defaults),/same ID|相同身份/);
	await duplicate.cleanup();
	assert.deepEqual(await fs.readdir(path.join(root,input.parent)),['Imported']);
});
