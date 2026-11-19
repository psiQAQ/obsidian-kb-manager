import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import test from 'node:test';
import {initializeRepository} from '../src/git/repository.ts';
import {readRepositoryIdentity,writeRepositoryIdentity} from '../src/git/identity.ts';
import {previewVersion,saveVersion,history} from '../src/git/versions.ts';

async function setup(t) {
	await fs.mkdir('.tmp',{recursive:true});
	const root=await fs.mkdtemp(path.resolve('.tmp/git-identity-'));
	t.after(()=>fs.rm(root,{recursive:true,force:true}));
	await initializeRepository(root);
	return root;
}
const cfg=dir=>path.join(dir,'.git','config');
const identity=(name,email)=>({name,email});
const read=async dir=>(await readRepositoryIdentity(dir)).identity;
const configure=async(dir,value)=>writeRepositoryIdentity(dir,await readRepositoryIdentity(dir),value);

test('commits resolve only local names and emails and reject missing or changed identities before staging',async t=>{
	const parent=await setup(t);
	const owner=identity('Parent','parent@example.invalid');
	await configure(parent,owner);
	const libraries=[];
	for(const name of ['one','two']){
		const dir=path.join(parent,name);
		await fs.mkdir(dir);
		await initializeRepository(dir);
		libraries.push(dir);
		await fs.writeFile(path.join(dir,'same.md'),name);
		assert.deepEqual(await read(dir),identity('',''));
		await assert.rejects(saveVersion(dir,await previewVersion(dir),'missing'),/user\.name/u);
		await assert.rejects(fs.stat(path.join(dir,'.git','index')),{code:'ENOENT'});
	}
	const people=[identity('研究员 #1','one@example.invalid'),identity('Second; author','two@example.invalid')];
	for(const [i,dir] of libraries.entries()){
		const stale=await previewVersion(dir);
		await configure(dir,people[i]);
		assert.deepEqual(await read(dir),people[i]);
		await assert.rejects(saveVersion(dir,stale,'outdated'),/变化|changed/u);
		await saveVersion(dir,await previewVersion(dir),'first');
		const [{commit}]=(await history(dir)).entries;
		assert.equal(commit.author.name,people[i].name);
		assert.equal(commit.committer.email,people[i].email);
	}
	assert.deepEqual(await read(parent),owner);
});

test('config previews preserve other settings and handle external edits, locks and ambiguous fields',async t=>{
	const dir=await setup(t),file=cfg(dir);
	const untouched='\n# baseline\n[remote "origin"]\n\turl = https://example.invalid/a.git\n';
	await fs.appendFile(file,untouched);
	const before=await readRepositoryIdentity(dir), change=identity('Local Person','local@example.invalid');
	await fs.appendFile(file,'# newer setting\n');
	await assert.rejects(writeRepositoryIdentity(dir,before,change),/changed|变化/u);
	const latest=await readRepositoryIdentity(dir);
	await fs.writeFile(file+'.lock','another process');
	await assert.rejects(writeRepositoryIdentity(dir,latest,change),{code:'EEXIST'});
	assert.equal(await fs.readFile(file+'.lock','utf8'),'another process');
	await fs.unlink(file+'.lock');
	await writeRepositoryIdentity(dir,latest,change);
	assert.ok((await fs.readFile(file,'utf8')).includes(untouched+'# newer setting\n'));
	await fs.appendFile(file,'\n[user]\n\tname = Duplicate\n');
	const dup=await readRepositoryIdentity(dir);
	assert.equal(dup.identity.name,'Duplicate');
	const old=await fs.readFile(file);
	await assert.rejects(writeRepositoryIdentity(dir,dup,change),/多个值|duplicate/u);
	assert.deepEqual(await fs.readFile(file),old);
	await fs.appendFile(file,'\n[user]\n\tname\n');
	assert.equal((await read(dir)).name,'');
	await assert.rejects(saveVersion(dir,await previewVersion(dir),'missing'),/user\.name/u);
	await fs.appendFile(file,'[include]\n\tpath = other.config\n');
	assert.equal((await read(dir)).indirect,true);
	await assert.rejects(configure(dir,change),/包含文件|Includes/u);
	assert.equal((await fs.readdir(path.dirname(file))).some(n=>n==='config.lock' || n.startsWith('kb-config-')),false);
});

test('included or worktree identities stay unconfirmed while local history remains readable',async t=>{
	const dir=await setup(t),local=identity('Library','library@example.invalid');
	await configure(dir,local);
	await fs.writeFile(path.join(dir,'a.md'),'first');
	const oid=await saveVersion(dir,await previewVersion(dir),'first');
	const base=await fs.readFile(cfg(dir),'utf8');
	for(const [name,extra] of [['include','[include]\n path = included.config'],['includeIf','[includeIf "onbranch:main"]\n path = included.config'],['worktree','[extensions]\n worktreeConfig = true']]){
		await fs.writeFile(cfg(dir),base+'\n'+extra+'\n');
		if(name==='worktree')await fs.writeFile(path.join(dir,'.git','config.worktree'),'[user]\n name = Worktree\n');
		assert.deepEqual(await read(dir),{...local,indirect:true});
		await assert.rejects(configure(dir,local),/包含文件|Includes/u);
		await assert.rejects(previewVersion(dir),/特殊 Git 配置|config.worktree|Unsupported Git configuration/u);
		assert.equal((await history(dir)).entries[0].oid,oid);
	}
});
