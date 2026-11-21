import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import {address,endpoint} from '../src/git/network-http.ts';
import {initializeRepository} from '../src/git/repository.ts';
import {applyChange,bindRemote,bindingPlan,changePlan,createBranch,remoteState,transfer} from '../src/git/network.ts';
import {blameLine,configureGitExecutable,gitResult,probeGitExecutable,sshRoute} from '../src/git/network-native.ts';
import {clearUndo,finishMerge,inspectMerge,markResolved,undoInfo} from '../src/git/network-merge.ts';
import {readGrants,AutomationClock,selectPaths} from '../src/git/network-automation.ts';
import {deletionPlan,removeBranch,remoteRemoval,removeRemote,serverBranches,trackBranch} from '../src/git/network-refs.ts';
import {previewVersion,saveVersion} from '../src/git/versions.ts';
import {vaultDisk} from './fixtures/vault-disk.mjs';

test('desktop native launches exclude vault paths and keep device Git configuration', async t => {
	const workspace=path.resolve('.tmp');
	await fs.mkdir(workspace,{recursive:true});
	const root=await fs.mkdtemp(path.join(workspace,'native-executables-'));
	const originalPath=process.env.PATH,originalConfig=process.env.GIT_CONFIG_GLOBAL;
	t.after(async()=>{
		configureGitExecutable('');
		if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;
		if(originalConfig===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=originalConfig;
		assert.equal(path.dirname(root),workspace);
		await fs.rm(root,{recursive:true,force:true});
	});
	const vault=path.join(root,'vault'),runtime=path.join(vault,'runtime');
	await fs.mkdir(runtime,{recursive:true});
	const alias=path.join(vault,'external-runtime');
	await fs.symlink(path.dirname(process.execPath),alias,'junction');
	const override=path.join(alias,path.basename(process.execPath));
	const gitUnavailable=/找不到可用的系统 Git|System Git was not found/u;
	configureGitExecutable(override,vault);
	await assert.rejects(probeGitExecutable(),gitUnavailable);
	await assert.rejects(gitResult(undefined,['--version']),gitUnavailable);

	configureGitExecutable('',vault);
	assert.match(await probeGitExecutable(),/^git version /u);
	const config=path.join(root,'device.gitconfig');
	await fs.writeFile(config,'[user]\n\tname = Device Git User\n');
	process.env.GIT_CONFIG_GLOBAL=config;
	assert.equal((await gitResult(undefined,['config','--global','--get','user.name'])).stdout.toString().trim(),'Device Git User');

	const suffix=process.platform==='win32'?'.exe':'';
	for(const name of ['git','ssh'])await fs.writeFile(path.join(runtime,name+suffix),'fixture',{mode:0o700});
	const external=path.join(root,'linked-runtime');
	await fs.symlink(runtime,external,'junction');
	process.env.PATH=external;
	await assert.rejects(gitResult(undefined,['--version']),gitUnavailable);
	await assert.rejects(sshRoute(new URL('ssh://git@fixture.invalid/repo')),/Vault 外可用的 OpenSSH|OpenSSH executable outside the vault/u);
});

test('HTTPS uses system helpers or the explicitly supplied endpoint token, without leaking failures',async t=>{
 const {root,dir,target,requests,requireAuth}=await fixture(t,true);
 const url=new URL(target.url);
 requireAuth('helper','fixture-system');
 const store=path.join(process.env.HOME,'credentials');
 await fs.writeFile(store,'https://helper:fixture-system@'+url.host+'\n',{mode:0o600});
 git(root,'config','--global','credential.helper','store --file="'+store.replaceAll('\\','/')+'"');
 await transfer(dir,'push',target);
 assert.ok(requests.includes('accepted'));
 await fs.writeFile(store,'',{mode:0o600});
 requireAuth('fallback','fixture-secret');
 await assert.rejects(transfer(dir,'fetch',target),e=>!String(e).includes(url.host)&&!String(e).includes('fixture-secret'));
 await transfer(dir,'fetch',target,{username:'fallback',password:'fixture-secret'});
 git(dir,'config','credential.helper','store');
 await assert.rejects(transfer(dir,'push',target),e=>!String(e).includes('fixture-secret'));
});

test('authorization migration scrubs URLs, secrets, raw errors and obsolete backend choices',()=>{
 const id='12345678-1234-1234-1234-123456789abc';
 const old={location:'kb/A',branch:'main',remote:'origin',remoteBranch:'main',url:'https://fixture-private.invalid/lib',backend:'builtin',
  paused:'helper error including synthetic-token',commit:1,push:2,pull:0,autoPullOnStart:false,autoFromLastCommit:false,autoAfterEdits:false,autoGlobMode:'exclude',autoGlobs:''};
 const saved=readGrants({[id]:old});
 assert.equal(saved[id].paused,'review');
 assert.doesNotMatch(JSON.stringify(saved),/fixture-private|synthetic-token|backend|"url"/u);
 assert.deepEqual(readGrants(saved),saved);
 const local=readGrants({[id]:{...old,paused:undefined,push:0}});
 assert.equal(local[id].paused,undefined);
});

test('rebind previews upstream, retains the explicit push address, and detects stale or ambiguous configuration',async t=>{
	const {dir,target}=await fixture(t);
	const proposed='https://next.invalid/project',pushUrl='https://publish.invalid/other';
	git(dir,'config','remote.origin.pushurl',pushUrl);
	const before=(await remoteState(dir)).target;
	const plan=await bindingPlan(dir,'main','origin',proposed,'upstream');
	assert.equal(plan.old.url,target.url);
	assert.equal(plan.oldPush.url,pushUrl);
	assert.equal(plan.push.url,pushUrl);
	git(dir,'config','branch.main.description','external edit');
	await assert.rejects(bindRemote(dir,'main','origin',proposed,'upstream',plan));
	assert.equal(git(dir,'config','remote.origin.url'),target.url);
	await bindRemote(dir,'main','origin',proposed,'upstream',await bindingPlan(dir,'main','origin',proposed,'upstream'));
	const after=(await remoteState(dir)).target;
	assert.equal(after.url,proposed);
	assert.equal(after.pushUrl,pushUrl);
	assert.equal(after.remoteBranch,'upstream');
	assert.notEqual(after.signature,before.signature);
	git(dir,'config','--add','remote.origin.url','https://second.invalid/repo');
	await assert.rejects(bindingPlan(dir,'main','origin',proposed,'upstream'));
});

test('SSH adapter exchanges real Git packs over an isolated command transport',async t=>{
	const compiler=process.platform==='win32'?'gcc':'cc';
	if(spawnSync(compiler,['--version']).error?.code==='ENOENT'){
		t.skip('C compiler unavailable for the local SSH transport fixture');return;
	}
	const {dir,bare}=await fixture(t);
	const home=process.env.HOME,cwd=process.cwd();
	const shim=path.join(home,process.platform==='win32'?'ssh.exe':'ssh');
	execFileSync(compiler,[path.join(cwd,'tests','fixtures','ssh-transport.c'),'-o',shim],{cwd:home,stdio:'pipe'});
	const original=process.env.PATH;process.env.PATH=home+path.delimiter+original;
	try{
		const url='ssh://git@fixture.invalid:2222/remote.git';
		await bindRemote(dir,'main','ssh-origin',url,'main');
		const target=(await remoteState(dir)).target;
		assert.match(target.fetchDisplay,/fixture.invalid:2222/u);
		await assert.rejects(transfer(dir,'push',target,{username:'private',password:'local-only'}));
		await transfer(dir,'push',target);
		assert.equal(git(bare,'rev-parse','main'),git(dir,'rev-parse','HEAD'));
		git(dir,'update-ref','-d','refs/remotes/ssh-origin/main');
		await transfer(dir,'fetch',target);
		assert.equal(git(dir,'rev-parse','refs/remotes/ssh-origin/main'),git(bare,'rev-parse','main'));
	}finally{process.env.PATH=original;}
});

test('repository URLs reject credentials, remote helpers and changed effective targets',async t=>{
 const {root,dir,target}=await fixture(t);
 for(const raw of ['https://u:canary@host.invalid/r','https://host.invalid/r?token=canary','file:///vault','ext::git','ssh://u:canary@alias/path'])
  assert.throws(()=>endpoint(raw),e=>!String(e).includes('canary'));
 assert.equal(endpoint('git@work-alias:team/repo.git'),'git@work-alias:team/repo.git');
 assert.equal(endpoint('ssh://git@work-alias:2222/srv/team.git'),'ssh://git@work-alias:2222/srv/team.git');
 const ssh=await address(dir,'ssh://git@127.0.0.1:2222/srv/team.git');
 assert.match(ssh.display,/git@127\.0\.0\.1:2222/u);
 git(root,'config','--global','url.https://different.invalid/.insteadOf',target.url);
 await assert.rejects(remoteState(dir),e=>!String(e).includes('different.invalid'));
});


const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
async function fixture(t,tls=false){
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp','network-'));
	let backend;
	const home=path.join(root,'isolated-home');await fs.mkdir(home);
	const original=Object.fromEntries(['HOME','USERPROFILE','XDG_CONFIG_HOME','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM'].map(key=>[key,process.env[key]]));
	for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME'])process.env[key]=home;
	process.env.GIT_CONFIG_GLOBAL=path.join(home,'.gitconfig');
	process.env.GIT_CONFIG_NOSYSTEM='1';
	t.after(async()=>{
		try{
			if(backend?.listening){
				backend.closeAllConnections();
				await new Promise((resolve,reject)=>backend.close(e=>e?reject(e):resolve()));
			}
		}finally{
			for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
			await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:150});
		}
	});
	git(root,'config','--global','core.autocrlf','false');
	git(root,'init','--quiet');
	const dir=path.join(root,'A'),bare=path.join(root,'remote.git');
	await fs.mkdir(dir);await initializeRepository(dir);
	git(dir,'config','user.name','Tester');git(dir,'config','user.email','test@example.invalid');
	await fs.writeFile(path.join(dir,'.gitignore'),'/kb.toml\n');await fs.writeFile(path.join(dir,'note.md'),'one\n');
	git(dir,'add','.');git(dir,'commit','-qm','first');
	git(root,'init','--bare','--quiet','--initial-branch=main',bare);git(bare,'config','http.receivepack','true');
	let expected;
	const requests=[];
	const handler=async(req,res)=>{
		const header=req.headers.authorization??'';
		requests.push(header===expected?'accepted':'anonymous');
		if(expected && header!==expected){
			res.writeHead(401,{'WWW-Authenticate':'Basic realm="library"'});res.end();return;
		}
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
	};
	if(tls){
		const key=path.join(home,'key.pem'),cert=path.join(home,'ca.pem');
		const config=path.join(home,'certificate.cnf');
		await fs.writeFile(config,'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
		execFileSync('openssl',['req','-config',config,'-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert],{cwd:home,stdio:'pipe'});
		git(root,'config','--global','http.schannelUseSSLCAInfo','true');
		git(root,'config','--global','http.sslCAInfo',cert);
		backend=createTlsServer({key:await fs.readFile(key),cert:await fs.readFile(cert)},handler);
	}else backend=createServer(handler);
	await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
	const url=(tls?'https':'http')+'://127.0.0.1:'+backend.address().port+'/remote.git';
	await bindRemote(dir,'main','origin',url,'main');
	return {root,dir,bare,requests,requireAuth:(user,token)=>{expected='Basic '+Buffer.from(user+':'+token).toString('base64');},target:(await remoteState(dir)).target};
}

test('System Git operations address only the selected nested repository',async t=>{
	const {root,dir,bare,target}=await fixture(t);
	const index=path.join(root,'.git','index');
	const parentBranch=git(root,'symbolic-ref','HEAD');
	await transfer(dir,'push',target);
	assert.equal(git(bare,'rev-parse','refs/heads/main'),git(dir,'rev-parse','HEAD'));
	const peer=path.join(root,'B');
	git(root,'clone','--quiet','--branch','main',bare,peer);
	await fs.writeFile(path.join(peer,'note.md'),'two\n');
	git(peer,'add','note.md');git(peer,'-c','user.name=Peer','-c','user.email=peer@example.invalid','commit','-qm','second');git(peer,'push','-q','origin','main');
	await transfer(dir,'fetch',target);
	const plan=await changePlan(dir,'refs/remotes/origin/main');
	assert.deepEqual(plan.changes,['note.md']);
	await applyChange(dir,plan,'pull','ff-only');
	assert.equal(await fs.readFile(path.join(dir,'note.md'),'utf8'),'two\n');
	assert.equal(git(dir,'rev-parse','HEAD'),git(peer,'rev-parse','HEAD'));
	await createBranch(dir,'topic');
	await applyChange(dir,await changePlan(dir,'refs/heads/topic'),'switch','ff-only');
	assert.equal(git(dir,'branch','--show-current'),'topic');
	assert.equal((await blameLine(dir,'note.md',1)).author,'Peer');
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
	const grant={location:'kb/A',branch:'main',remote:'origin',routeDigest:'a'.repeat(64),remoteBranch:'main',commit:1,pull:0,push:5,
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
	await transfer(dir,'push',target);
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
	await assert.rejects(applyChange(dir,plan,'pull','merge','theirs'),/user\.name/u);
	git(dir,'config','user.name','Library author');git(dir,'config','user.email','library@example.invalid');
	await applyChange(dir,await changePlan(dir,'refs/heads/side'),'pull','merge','theirs');
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
	await applyChange(dir,await changePlan(dir,'refs/heads/side'),'pull','rebase');
	assert.equal(git(dir,'show','-s','--format=%an/%cn <%ce>'),'Tester/Rebaser <rebaser@example.invalid>');
});




test('clone inspects a remote library before publishing and preserves a competing destination',async t=>{
	const {downloadLibrary}=await import('../src/kb/clone.ts');
	const {defaults,newIdentity}=await import('../src/kb/catalog.ts');
	const {root,dir,target}=await fixture(t);
	const {writeIdentity,parseIdentity}=await import('../src/kb/identity-core.ts');
	const original=newIdentity('Research','',{id:'custom',version:'1'});
	const choice={kind:'original',raw:writeIdentity('',original)};
	await transfer(dir,'push',target);
	const disk=vaultDisk(root,'.vault-settings'), input={parent:defaults.parents[0],name:'Imported',url:target.url};
	const clone=await downloadLibrary(disk,defaults,input);
	assert.ok(clone.files.includes('note.md'));
	const destination=path.join(root,input.parent,input.name);
	await fs.mkdir(destination);
	await assert.rejects(clone.publish(defaults),/exists|已存在/);
	await fs.rmdir(destination);
	await assert.rejects(clone.publish(defaults));
	await clone.publish(defaults,choice);
	assert.equal(parseIdentity(await fs.readFile(path.join(destination,'kb.toml'),'utf8')).id,original.id);
	assert.equal(git(destination,'ls-files','--','kb.toml'),'');
	assert.equal(git(destination,'rev-parse','HEAD'),git(dir,'rev-parse','HEAD'));
	const duplicate=await downloadLibrary(disk,defaults,{...input,name:'Copy'});
	await assert.rejects(duplicate.publish(defaults,choice),/same ID|相同身份/);
	await duplicate.publish(defaults,{kind:'new'});
	const copy=path.join(root,input.parent,'Copy');
	assert.notEqual(parseIdentity(await fs.readFile(path.join(copy,'kb.toml'),'utf8')).id,original.id);
	assert.equal(git(copy,'status','--porcelain'),'');
});

test('a managed manifest cannot be staged, committed or published through plugin Git',async t=>{
 const {root,dir,target}=await fixture(t);
 const {changeIndex}=await import('../src/git/index-actions.ts');
 const {writeIdentity}=await import('../src/kb/identity-core.ts');
 const {newIdentity}=await import('../src/kb/catalog.ts');
 const file=path.join(dir,'kb.toml');
 await fs.writeFile(file,writeIdentity('',newIdentity('Local only','',{id:'test',version:'1'})));
 await fs.writeFile(path.join(dir,'.gitignore'),'');
 let preview=await previewVersion(dir);
 await assert.rejects(changeIndex(dir,preview,'stage',['kb.toml']),/kb\.toml/);
 assert.equal(git(dir,'ls-files','--','kb.toml'),'');
 git(dir,'add','--','kb.toml');
 preview=await previewVersion(dir);
 await assert.rejects(saveVersion(dir,preview,'blocked'),/kb\.toml/);
 assert.equal(git(dir,'diff','--cached','--name-only'),'kb.toml');
 git(dir,'commit','-qm','externally tracked manifest');
 git(dir,'rm','--cached','kb.toml');
 git(dir,'commit','-qm','remove from tip');
 await assert.rejects(transfer(dir,'push',target),/kb\.toml/);
 assert.equal(git(path.join(root,'remote.git'),'for-each-ref','--format=%(refname)'),'');
});
