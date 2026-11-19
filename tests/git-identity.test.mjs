import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import {initializeRepository} from '../src/git/repository.ts';
import {readRepositoryIdentity,writeRepositoryIdentity} from '../src/git/identity.ts';
import {previewVersion,saveVersion,history} from '../src/git/versions.ts';
import {gitResult} from '../src/git/network-native.ts';

async function setup(t){
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp/git-identity-')),home=path.join(root,'home'),dir=path.join(root,'lib');
	await fs.mkdir(home);await fs.mkdir(dir);
	const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'xdg')};
	const before=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
	Object.assign(process.env,env);
	t.after(async()=>{
		for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
		await fs.rm(root,{recursive:true,force:true});
	});
	await initializeRepository(dir);
	return {dir,home,root};
}
const cfg=dir=>path.join(dir,'.git','config');
const identity=(name,email)=>({name,email});
const read=async dir=>(await readRepositoryIdentity(dir)).identity;
const configure=async(dir,value)=>writeRepositoryIdentity(dir,await readRepositoryIdentity(dir),value);

test('each identity field follows Git configuration, including inherited values, local overrides and clearing',async t=>{
	const {home,root,dir}=await setup(t);
	const included=path.join(home,'profile.cfg'),global=path.join(home,'.gitconfig');
	await fs.writeFile(included,'[user]\n name = Global Name\n email = global@example.invalid\n');
	await fs.writeFile(global,'[include]\n path = profile.cfg\n');
	const globalBytes=await fs.readFile(global),other=path.join(root,'other');
	await fs.mkdir(other);await initializeRepository(other);
	const inherited=identity('Global Name','global@example.invalid'),local=identity('研究员 #1','local@example.invalid');
	const first=await readRepositoryIdentity(dir);
	assert.deepEqual(first.identity,inherited);assert.deepEqual(first.local,identity('',''));
	assert.equal(first.values.name.at(-1).scope,'global');
	assert.ok(first.values.name.at(-1).origin.includes('profile.cfg'));
	await configure(dir,identity(local.name,''));
	let preview=await readRepositoryIdentity(dir);
	assert.deepEqual(preview.identity,identity(local.name,inherited.email));
	assert.deepEqual(preview.local,identity(local.name,''));
	assert.equal(preview.values.name.at(-1).direct,true);
	await fs.writeFile(path.join(dir,'same.md'),'hello');
	const stale=await previewVersion(dir);
	await configure(dir,identity('',local.email));
	await assert.rejects(saveVersion(dir,stale,'stale'),/变化|changed/u);
	preview=await readRepositoryIdentity(dir);
	assert.deepEqual(preview.identity,identity(inherited.name,local.email));
	await saveVersion(dir,await previewVersion(dir),'first');
	const [{commit}]=(await history(dir)).entries;
	assert.equal(commit.author.name,inherited.name);assert.equal(commit.committer.email,local.email);
	assert.deepEqual(await read(other),inherited);
	await configure(dir,identity('',''));
	assert.deepEqual(await read(dir),inherited);
	for(const key of ['name','email'])assert.equal((await gitResult(dir,['config','--local','--no-includes','--get-all','user.'+key],{allowedExitCodes:[0,1]})).code,1);
	assert.deepEqual(await fs.readFile(global),globalBytes);
});

test('config writes reject changed local or inherited values and foreign locks while preserving unrelated settings',async t=>{
	const {dir,home}=await setup(t),file=cfg(dir),change=identity('Local Person','local@example.invalid');
	const other='\n# note\n[remote "origin"]\n\turl = https://example.invalid/a.git\n';
	await fs.appendFile(file,other);
	const before=await readRepositoryIdentity(dir);
	await fs.appendFile(file,'# new setting\n');
	await assert.rejects(writeRepositoryIdentity(dir,before,change),/changed|变化/u);
	const previous=await readRepositoryIdentity(dir);
	await fs.writeFile(path.join(home,'.gitconfig'),'[user]\n name = Another\n');
	await assert.rejects(writeRepositoryIdentity(dir,previous,change),/changed|变化/u);
	const latest=await readRepositoryIdentity(dir);
	await fs.writeFile(file+'.lock','another process');
	await assert.rejects(writeRepositoryIdentity(dir,latest,change),{code:'EEXIST'});
	assert.equal(await fs.readFile(file+'.lock','utf8'),'another process');
	await fs.unlink(file+'.lock');await writeRepositoryIdentity(dir,latest,change);
	assert.ok((await fs.readFile(file,'utf8')).includes(other+'# new setting\n'));
});

test('unconfigured author or email stops a save before staging, and history opens independently',async t=>{
	const {dir,home}=await setup(t);
	await fs.writeFile(path.join(home,'.gitconfig'),'[user]\n name = ""\n email = ""\n');
	await fs.writeFile(path.join(dir,'a.md'),'first');
	await assert.rejects(saveVersion(dir,await previewVersion(dir),'missing'),/user\.name/u);
	await assert.rejects(fs.stat(path.join(dir,'.git','index')),{code:'ENOENT'});
	assert.deepEqual((await history(dir)).entries,[]);
});

test('native author and committer overrides must match the preview before staging or creating commits',async t=>{
	const {dir,home}=await setup(t);
	const note=path.join(dir,'note.md'),global=path.join(home,'.gitconfig');
	const normal='[user]\n name = Preview Name\n email = preview@example.invalid\n';
	await fs.writeFile(global,normal);
	await fs.writeFile(note,'initial\n');
	const initial=await saveVersion(dir,await previewVersion(dir),'seed');
	await fs.writeFile(note,'changed\n');
	const index=path.join(dir,'.git','index'),originalIndex=await fs.readFile(index);
	const reject=async(plan,role)=>{
		await assert.rejects(saveVersion(dir,plan,'unconfirmed identity'),new RegExp(role));
		assert.equal((await gitResult(dir,['rev-parse','HEAD'])).stdout.toString().trim(),initial);
		assert.deepEqual(await fs.readFile(index),originalIndex);
	};
	for(const [config,role] of [['[author]\n name = Independent Author\n','GIT_AUTHOR_IDENT'],['[committer]\n email = committer@example.invalid\n','GIT_COMMITTER_IDENT']]){
		const plan=await previewVersion(dir);
		await fs.writeFile(global,normal+config);
		await reject(plan,role);
		assert.equal((await history(dir)).entries.length,1);
		await fs.writeFile(global,normal);
	}
	const plan=await previewVersion(dir),key='GIT_AUTHOR_NAME',before=process.env[key];
	try{
		process.env[key]='Environment Author';
		await reject(plan,'GIT_AUTHOR_IDENT');
	}finally{if(before===undefined)delete process.env[key];else process.env[key]=before;}
	await saveVersion(dir,plan,'matched identity');
	assert.equal((await history(dir)).entries.length,2);
});
