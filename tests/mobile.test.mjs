import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import * as path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createPreview,instantiate,discoverMobile} from '../src/mobile/catalog.ts';
import {parseIdentity,readManifest,writePreferences} from '../src/kb/identity-core.ts';
import {assignMobileCopyId,registerMobile,scanMobile,selectMobileManifest,verifyLibrary} from '../src/mobile/registration.ts';
import {applyLibraryBindings,previewBindings,resumeLibraryBindings} from '../src/mobile/bindings.ts';
import {mobileRepo} from '../src/mobile/disk.ts';
import {mobileStatus,editIndex,commit,mobileHistory,effectiveAuthor,localAuthor,configure} from '../src/mobile/git.ts';
import {download,applyPull,pullPlan,transfer,upstream} from '../src/mobile/remote.ts';
import {mobileHttp} from '../src/mobile/http.ts';
import {readMobileStorage} from '../src/mobile/storage.ts';

function adapter(root){
	const f=p=>path.join(root,p);
	return {
		stat:async p=>{
			try{const s=await fs.stat(f(p));return {type:s.isDirectory()?'folder':'file',size:s.size,ctime:s.ctimeMs,mtime:s.mtimeMs};}
			catch(e){if(e.code==='ENOENT' || e.code==='ENOTDIR')return null;throw e;}
		},
		list:async p=>{const files=[],folders=[];for(const e of await fs.readdir(f(p),{withFileTypes:true})){
			(e.isDirectory()?folders:files).push(p?p+'/'+e.name:e.name);
		}return {files,folders};},
		read:p=>fs.readFile(f(p),'utf8'),readBinary:async p=>Uint8Array.from(await fs.readFile(f(p))).buffer,
		process:async(p,change)=>{const next=change(await fs.readFile(f(p),'utf8'));await fs.writeFile(f(p),next);return next;},
		write:(p,s)=>fs.writeFile(f(p),s),writeBinary:(p,b)=>fs.writeFile(f(p),new Uint8Array(b)),
		mkdir:p=>fs.mkdir(f(p)),rmdir:(p,r)=>r?fs.rm(f(p),{recursive:true}):fs.rmdir(f(p)),
		copy:(a,b)=>fs.copyFile(f(a),f(b),constants.COPYFILE_EXCL),remove:p=>fs.unlink(f(p)),rename:(a,b)=>fs.rename(f(a),f(b)),
	};
}
async function setup(t){
	await fs.mkdir('.tmp',{recursive:true});const root=await fs.mkdtemp(path.resolve('.tmp','mobile-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	const disk=adapter(root);return {root,disk,ctx:{disk,configDir:'.mobile-settings',parents:['libs'],templates:['templates/sample']}};
}
async function inputs(root){
	const read=async folder=>Object.fromEntries(await Promise.all((await fs.readdir(folder,{recursive:true,withFileTypes:true}))
		.filter(e=>e.isFile()).map(async e=>{
			const file=path.join(e.parentPath,e.name);
			return [path.relative(folder,file).replaceAll('\\','/'),await fs.readFile(file,'utf8')];
		})));
	await fs.mkdir(path.join(root,'templates/sample'),{recursive:true});
	await fs.writeFile(path.join(root,'templates/sample/pic.bin'),Uint8Array.from([0,1,255,10]));
	await fs.writeFile(path.join(root,'templates/sample/hello.md'),'{{kb_name}}');
	await fs.writeFile(path.join(root,'templates/sample/kb-template.json'),JSON.stringify({text:{'hello.md':['kb_name']},entry:'hello.md'}));
	return {wiki:await read('assets/llm-wiki'),kepano:await read('assets/kepano')};
}
const author={name:'Initial Author',email:'initial@example.invalid'};
test('mobile adapter creates all template types and preserves each library index and device author fallback',async t=>{
	const {root,disk,ctx}=await setup(t),assets=await inputs(root);
	await disk.mkdir('.git');
	await disk.write('.gitignore','# existing rule\n/cache/\n');
	const native=(name,...args)=>execFileSync('git',['-C',path.join(root,'libs',name),...args]);
	for(const [name,source] of [['a',''],['b','builtin:kepano'],['c','templates/sample']]){
		const preview=await createPreview(ctx,{name,parent:'libs',displayName:name,description:'demo',source,author},assets);
		const result=await instantiate(ctx,preview,assets);
		assert.equal(result.head,native(name,'rev-parse','HEAD').toString().trim());
		assert.equal(native(name,'log','-1','--format=%s%n%an%n%ae%n%cn%n%ce').toString().trim(),
			['Initial commit',author.name,author.email,author.name,author.email].join('\n'));
		assert.deepEqual(native(name,'ls-tree','--name-only','-r','-z','HEAD').toString().split('\0').filter(Boolean).sort(),preview.initial.files.map(file=>file.name).sort());
		assert.equal(native(name,'status','--porcelain').length,0);
		assert.equal(native(name,'check-ignore','kb.toml').toString().trim(),'kb.toml');
		assert.deepEqual(await instantiate(ctx,preview,assets),result);
	}
	assert.equal((await discoverMobile(ctx)).length,3);
	assert.deepEqual(JSON.parse(await disk.read('.kb-manager/libraries.json')),['libs/a','libs/b','libs/c']);
	assert.equal(await disk.read('.gitignore'),'# existing rule\n/cache/\n/.kb-manager/\n');
	assert.equal((await disk.stat('libs/a/kb-manager.json')),null);
	assert.equal(readManifest(await disk.read('libs/a/kb.toml')).mapping.wiki,'wiki');
	assert.match(await disk.read('libs/a/.gitignore'),/^\/kb\.toml$/mu);
	assert.equal(await disk.read('libs/c/hello.md'),'c');
	assert.deepEqual(new Uint8Array(await disk.readBinary('libs/c/pic.bin')),Uint8Array.from([0,1,255,10]));
	assert.ok(!(await disk.read('libs/a/knowledge.base')).includes('__KB_ROOT__'));
	assert.ok(!(await disk.read('libs/b/README.md')).includes('__KB_ROOT__'));
	const s={root:'libs/a',disk,configDir:ctx.configDir};
	await disk.write('libs/a/README.md','staged edit');
	const old=await mobileStatus(s);
	await editIndex(s,old,['README.md'],true);
	const snapshot=await mobileStatus(s);
	await disk.write('libs/a/README.md','unstaged');
	await assert.rejects(commit(s,snapshot,'stale',{name:'N',email:'e@example.invalid'}));
	await configure(s,await mobileStatus(s),{'user.name':'Local','user.email':undefined});
	const device={name:'Device',email:'d@example.invalid'};
	assert.deepEqual(effectiveAuthor(await localAuthor(s),device),{name:'Local',email:device.email});
	await commit(s,await mobileStatus(s),'staged',device);
	assert.equal((await mobileHistory(s)).entries[0].commit.author.name,'Local');
	assert.notEqual(native('a','show','HEAD:README.md').toString(),'unstaged');
	assert.equal(native('b','rev-list','--count','HEAD').toString().trim(),'1');
	await configure(s,await mobileStatus(s),{'user.name':undefined});
	assert.deepEqual(await localAuthor(s),{name:'',email:''});
	assert.deepEqual(effectiveAuthor(await localAuthor(s),device),device);
	const scoped=mobileRepo(disk,'libs/a',ctx.configDir);
	for(const file of ['../b/x','kb/../b/x','kb/'+ctx.configDir+'/config','kb/other/.git/config'])await assert.rejects(scoped.fs.promises.readFile(file));
	await disk.write('libs/a/.gitattributes','*.md text');
	await assert.rejects(mobileStatus(s));
});

test('mobile creation previews Git ignore rules, validates identity and configures a local HTTPS origin',async t=>{
	const {root,disk,ctx}=await setup(t),assets=await inputs(root);
	await disk.write('templates/sample/.gitignore','*.bin\n/nested/*\n!/nested/keep.md\n/pruned/\n!/kb.toml\n');
	await disk.mkdir('templates/sample/nested');
	await disk.write('templates/sample/nested/.gitignore','!extra.md\nkeep.md\n');
	await disk.write('templates/sample/nested/keep.md','ignored by nested rule');
	await disk.write('templates/sample/nested/extra.md','re-included by nested rule');
	await disk.mkdir('templates/sample/pruned');
	await disk.write('templates/sample/pruned/.gitignore','!hidden.md\n');
	await disk.write('templates/sample/pruned/hidden.md','ignored with its parent directory');
	const request={parent:'libs',name:'preview',displayName:'Preview',description:'',source:'templates/sample',author};
	await assert.rejects(createPreview(ctx,{...request,author:{...author,email:''}},assets));
	await assert.rejects(createPreview(ctx,{...request,origin:'git@example.invalid:team/kb.git'},assets));
	await assert.rejects(createPreview(ctx,{...request,origin:'https://secret@example.invalid/team/kb.git'},assets));
	const origin='https://example.invalid/team/kb.git',preview=await createPreview(ctx,{...request,origin},assets);
	assert.deepEqual(preview.initial.files.map(file=>file.name),['.gitignore','hello.md','nested/extra.md']);
	assert.equal(await disk.stat('libs'),null);
	assert.equal(await disk.stat('.kb-manager'),null);
	const receipt=await instantiate(ctx,preview,assets),store={...ctx,root:receipt.location};
	const native=(...args)=>execFileSync('git',['-C',path.join(root,receipt.location),...args]).toString().trim();
	assert.equal(receipt.branch,'main');
	assert.deepEqual(await localAuthor(store),author);
	assert.deepEqual(await upstream(store,receipt.branch),{remote:'origin',url:origin,branch:'main'});
	assert.equal(native('remote','get-url','origin'),origin);
	assert.doesNotMatch(native('config','--local','--list'),/^branch\.main\.(remote|merge)=/mu);
	assert.equal(native('status','--porcelain','--branch'),'## main');
	assert.deepEqual(native('ls-files').split('\n'),['.gitignore','hello.md','nested/extra.md']);
	assert.equal(native('for-each-ref','refs/remotes'),'');
	assert.equal(native('check-ignore','pruned/hidden.md'),'pruned/hidden.md');
	assert.deepEqual((await mobileStatus(store)).changes,[]);
	assert.equal(await disk.read('libs/preview/nested/keep.md'),'ignored by nested rule');
	assert.equal(parseIdentity(await disk.read('libs/preview/kb.toml')).id,receipt.identity.id);
});

test('mobile creation keeps ignored files local when the initial commit tree is empty',async t=>{
	const {root,disk,ctx}=await setup(t),assets=await inputs(root);
	await disk.write('templates/sample/.gitignore','*\n');
	const review=await createPreview(ctx,{parent:'libs',name:'empty',displayName:'Empty',description:'',source:'templates/sample',author},assets);
	assert.deepEqual(review.initial.files,[]);
	const result=await instantiate(ctx,review,assets);
	const native=(...args)=>execFileSync('git',['-C',path.join(root,result.location),...args]).toString().trim();
	assert.equal(native('ls-tree','-r','HEAD'),'');
	assert.equal(native('status','--porcelain','--branch'),'## main');
	assert.equal(native('log','-1','--format=%s'),'Initial commit');
	assert.equal(await disk.read('libs/empty/hello.md'),'Empty');
});

test('mobile creation retries copy and registration failures without duplicate commits or replacing another library',async t=>{
	const {root,disk,ctx}=await setup(t),assets=await inputs(root);
	await disk.mkdir('.git');
	const request={parent:'libs',name:'retry',displayName:'Retry',description:'',source:'templates/sample',author};
	const approval=await createPreview(ctx,request,assets),copy=disk.copy;
	disk.copy=async(a,b)=>{
		if(b==='libs/retry/pic.bin')throw new Error('fixture publication failure');
		return copy(a,b);
	};
	await assert.rejects(instantiate(ctx,approval,assets),/fixture publication failure/u);
	assert.equal(await disk.stat('libs/retry'),null);
	assert.deepEqual(await disk.list('libs'),{files:[],folders:[]});
	assert.deepEqual(await discoverMobile(ctx),[]);
	disk.copy=async(a,b)=>{
		if(b==='.kb-manager/libraries.json')throw new Error('fixture registry failure');
		return copy(a,b);
	};
	await assert.rejects(instantiate(ctx,approval,assets),/fixture registry failure/u);
	const gitHead=await disk.read('libs/retry/.git/refs/heads/main');
	assert.deepEqual(await discoverMobile(ctx),[]);
	disk.copy=copy;
	const receipt=await instantiate(ctx,approval,assets);
	assert.equal(receipt.head,gitHead.trim());
	assert.equal((await discoverMobile(ctx))[0].identity.id,receipt.identity.id);
	assert.deepEqual((await disk.list('libs')).folders,['libs/retry']);
	const conflicting=await createPreview(ctx,{...request,name:'conflict'},assets);
	await disk.mkdir(conflicting.location);
	await disk.write(conflicting.location+'/user.md','external file');
	await assert.rejects(instantiate(ctx,conflicting,assets));
	assert.equal(await disk.read(conflicting.location+'/user.md'),'external file');
	assert.equal(execFileSync('git',['-C',path.join(root,'libs/retry'),'rev-list','--count','HEAD']).toString().trim(),'1');
});

function smartHttps(bare,url,auth){
	const calls=[];
	const http=mobileHttp(url,async(address,options)=>{
		assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
		const req=new URL(address),discovery=req.pathname.endsWith('/info/refs');
		assert.equal(req.origin,new URL(url).origin);
		if(auth && new Headers(options.headers).get('Authorization')!=='Basic '+Buffer.from(auth.username+':'+auth.password).toString('base64')){
			return new Response(null,{status:401,headers:{'www-authenticate':'Basic realm="test"'}});
		}
		const service=discovery?req.searchParams.get('service'):req.pathname.split('/').pop();
		assert.ok(['git-upload-pack','git-receive-pack'].includes(service));
		calls.push(service);
		const packet='# service='+service+'\n';
		const result=execFileSync('git',[service.slice(4),'--stateless-rpc',...(discovery?['--advertise-refs']:[]),bare],{input:options.body?Buffer.from(options.body):undefined});
		const body=discovery?Buffer.concat([Buffer.from((packet.length+4).toString(16).padStart(4,'0')+packet+'0000'),result]):result;
		return new Response(body,{headers:{'content-type':'application/x-'+service+'-'+(discovery?'advertisement':'result')}});
	});
	return {http,calls};
}
test('mobile smart HTTPS clone, fetch, fast-forward and push isolate a managed library',async t=>{
	const {root,disk,ctx}=await setup(t),assets=await inputs(root);
	const input={parent:'libs',name:'seed',displayName:'Seed',description:'',source:'templates/sample',author};
	await instantiate(ctx,await createPreview(ctx,input,assets),assets);
	const bare=path.join(root,'remote.git'),seed=path.join(root,'libs','seed');
	const run=(...args)=>execFileSync('git',args,{stdio:['ignore','pipe','pipe']}).toString().trimEnd();
	const native=(...args)=>run('-C',seed,...args);
	run('clone','--bare',seed,bare);
	const url='https://example.invalid/team/kb.git',auth={username:'fixture',password:'fixture'},transport=smartHttps(bare,url,auth);
	await disk.mkdir('clones');
	const ctx2={...ctx,parents:['clones']};
	const plan=await download(ctx2,'clones','one',url,transport.http,auth);
	assert.ok(plan.files.includes('pic.bin'));
	assert.ok(!plan.files.includes('kb.toml'));
	assert.equal(plan.hasManifest,false);
	await assert.rejects(plan.review(ctx2,{mode:'embedded'},assets.kepano));
	await plan.publish(ctx2,await plan.review(ctx2,{mode:'new'},assets.kepano),assets.kepano);
	assert.notEqual(parseIdentity(await disk.read('clones/one/kb.toml')).id,parseIdentity(await disk.read('libs/seed/kb.toml')).id);
	const s={disk,configDir:ctx.configDir,root:'clones/one'};
	const old=await mobileStatus(s);
	assert.deepEqual(old.changes,[]);
	const target=await upstream(s,old.branch);
	assert.equal(target.url,url);
	await disk.write('libs/seed/hello.md','incoming from seed');
	native('add','hello.md');native('-c','user.name=Seed','-c','user.email=s@example.invalid','commit','-m','Update');
	native('push',bare,'main');
	await transfer(s,old,'fetch',target,transport.http,auth);
	const ff=await pullPlan(s);assert.deepEqual(ff.changes,['hello.md']);
	await disk.write('clones/one/extra','pending');
	await assert.rejects(applyPull(s,ff));assert.equal(await disk.read('clones/one/extra'),'pending');
	await disk.remove('clones/one/extra');
	await applyPull(s,ff);assert.equal(await disk.read('clones/one/hello.md'),'incoming from seed');
	await disk.write('clones/one/out.md','outgoing');
	await editIndex(s,await mobileStatus(s),['out.md'],true);
	await commit(s,await mobileStatus(s),'Mobile change',{name:'Mobile',email:'m@example.invalid'});
	await transfer(s,await mobileStatus(s),'push',target,transport.http,auth);
	assert.equal(run('--git-dir',bare,'show','main:out.md'),'outgoing');
	assert.deepEqual(await disk.stat('libs/seed/out.md'),null);
	assert.ok(transport.calls.includes('git-receive-pack'));
	const duplicate=await download(ctx2,'clones','duplicate',url,transport.http,auth);
	try{
		const review=await duplicate.review(ctx2,{mode:'original',raw:await disk.read('libs/seed/kb.toml')},assets.kepano);
		await assert.rejects(duplicate.publish(ctx2,review,assets.kepano));
		assert.equal(await disk.stat('clones/duplicate'),null);
	}
	finally{await duplicate.cleanup();}
	const separate=await setup(t),original=writePreferences(await disk.read('libs/seed/kb.toml'),{disablePush:true});
	const carried=await download(separate.ctx,'libs','carried',url,transport.http,auth);
	const review=await carried.review(separate.ctx,{mode:'original',raw:original},assets.kepano);
	await carried.publish(separate.ctx,review,assets.kepano);
	assert.equal(await separate.disk.read('libs/carried/kb.toml'),original);
	assert.equal((await discoverMobile(separate.ctx))[0].preferences.disablePush,true);
	const cloneNative=(...args)=>run('-C',path.join(root,'clones','one'),...args);
	cloneNative('add','-f','kb.toml');
	await assert.rejects(commit(s,await mobileStatus(s),'Private',{name:'Mobile',email:'m@example.invalid'}),/kb\.toml/u);
	cloneNative('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','Force track manifest');
	cloneNative('rm','--cached','kb.toml');
	cloneNative('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-m','Untrack manifest');
	const requests=transport.calls.length;
	await assert.rejects(transfer(s,await mobileStatus(s),'push',target,transport.http,auth),/kb\.toml/u);
	assert.equal(transport.calls.length,requests);
});

test('mobile rebuilds a registry from a selected folder and rebinds only matching files after a complete move',async t=>{
	const {root,disk,ctx}=await setup(t),assets=await inputs(root);
	const initial=await createPreview(ctx,{parent:'libs',name:'a',displayName:'Alpha',description:'',source:'builtin:kepano',author},assets);
	const {identity}=await instantiate(ctx,initial,assets);
	await disk.mkdir('incoming');
	await disk.rename('libs/a','incoming/moved');
	assert.equal((await discoverMobile(ctx))[0].missing,true);
	assert.deepEqual(JSON.parse(await disk.read('.kb-manager/libraries.json')),['libs/a']);
	const changed=identity.managed.find(item=>item.path!=='README.md').path;
	const changedPath='incoming/moved/'+changed,edited=await disk.read(changedPath)+'\nUser edit\n';
	await disk.write(changedPath,edited);
	const [found]=await scanMobile(ctx,'incoming');
	assert.equal(found.identity.id,identity.id);
	await registerMobile(ctx,[found],'libs/a');
	assert.deepEqual(JSON.parse(await disk.read('.kb-manager/libraries.json')),['incoming/moved']);
	const preview=await previewBindings(ctx,found.location,found.location,found.manifest,assets.kepano);
	assert.ok(preview.edits.some(edit=>edit.path==='README.md'));
	assert.ok(preview.manual.some(line=>line.includes(changed)));
	let recovery;
	const original=disk.process;
	disk.process=async(p,fn)=>{
		if(p===found.location+'/kb.toml')throw new Error('fixture interrupted');
		return original(p,fn);
	};
	await assert.rejects(applyLibraryBindings(ctx,found,preview,assets.kepano,plan=>{recovery=plan;}),/fixture interrupted/u);
	assert.equal(recovery,preview);
	disk.process=original;
	await resumeLibraryBindings(ctx,recovery,assets.kepano);
	assert.equal(await disk.read(changedPath),edited);
	assert.equal(parseIdentity(await disk.read(found.location+'/kb.toml')).managed.find(item=>item.path==='README.md').root,'incoming/moved');
	await fs.cp(path.join(root,'incoming/moved'),path.join(root,'incoming/copy'),{recursive:true});
	await registerMobile(ctx,[await selectMobileManifest(ctx,'incoming/copy/kb.toml')]);
	assert.ok((await discoverMobile(ctx)).every(lib=>lib.duplicate));
	await assert.rejects(verifyLibrary(ctx,found,true));
	await disk.remove('.kb-manager/libraries.json');
	assert.deepEqual(await discoverMobile(ctx),[]);
	assert.equal(await disk.stat('.kb-manager/libraries.json'),null);
	await registerMobile(ctx,await scanMobile(ctx,'incoming'));
	assert.deepEqual(JSON.parse(await disk.read('.kb-manager/libraries.json')),['incoming/copy','incoming/moved']);
	const source=await disk.read('incoming/moved/kb.toml');
	await disk.write('incoming/copy/kb.toml',writePreferences(source,{disablePush:true}));
	const copy=await selectMobileManifest(ctx,'incoming/copy/kb.toml');
	const copyId=crypto.randomUUID();
	await assignMobileCopyId(ctx,copy,'incoming/moved',copyId);
	assert.equal(await disk.read('incoming/moved/kb.toml'),source);
	const after=await selectMobileManifest(ctx,'incoming/copy/kb.toml');
	assert.equal(after.identity.id,copyId);
	assert.equal(after.preferences.disablePush,true);
	assert.ok((await discoverMobile(ctx)).every(lib=>!lib.duplicate));
});
test('mobile transport restricts authentication to the confirmed HTTPS endpoint and refuses redirect responses',async()=>{
	const url='https://example.invalid/team/kb.git';
	let requested=0;
	const http=mobileHttp(url,async(address,options)=>{
		assert.equal(options.redirect,'error');requested++;
		return Object.assign(new Response(''),{});
	});
	for(const address of ['https://different.invalid/team/kb.git/info/refs',url+'/other',url+'-sibling/info/refs']){
		await assert.rejects(http.request({url:address,headers:{Authorization:'Basic test'}}));
	}
	assert.equal(requested,0);
	await http.request({url:url+'/info/refs?service=git-upload-pack'});assert.equal(requested,1);
	const redirected=mobileHttp(url,async()=>({redirected:true,url:'https://different.invalid/'}));
	await assert.rejects(redirected.request({url:url+'/info/refs'}));
});

test('mobile migrates only global preferences and keeps incomplete records and paused legacy grants on the device',()=>{
	const id='10000000-0000-4000-8000-000000000001';
	const grant={location:'legacy/lib',branch:'main',remote:'origin',remoteBranch:'main',routeDigest:'a'.repeat(64),commit:1,pull:1,push:1,
		autoGlobs:'',autoGlobMode:'exclude',autoAfterEdits:false,autoFromLastCommit:false,autoPullOnStart:false};
	const old={parents:['legacy'],templates:['sample'],prefs:{language:'zh',defaults:{disablePush:true},libraries:{[id]:{tree:true}}},
		grants:{[id]:grant},moves:{done:{phase:'complete'},pending:{phase:'moved'}},saves:{done:{committed:'ok'},pending:{committed:'ok',problem:'check'}}};
	const {saved,device}=readMobileStorage(old,{parents:['device'],retained:{value:'unchanged'}});
	assert.deepEqual(saved,{language:'zh',defaults:{disablePush:true}});
	assert.deepEqual(device.parents,['device']);
	assert.deepEqual(device.templates,['sample']);
	assert.equal(device.grants[id].paused,'review');
	assert.deepEqual(Object.keys(device.moves),['pending']);
	assert.deepEqual(Object.keys(device.saves),['pending']);
	assert.deepEqual(device.pendingLibraryPreferences,{[id]:{tree:true}});
	assert.deepEqual(device.retained,{value:'unchanged'});
	assert.equal(readMobileStorage(saved,{...device,grants:{[id]:grant}}).device.grants[id].paused,undefined);
});
