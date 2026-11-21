import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {test} from 'node:test';
import {digest} from '../src/fs/vault.ts';
import {checkKitFiles,checkKitVersion} from '../src/kb/check-kit.ts';
import {applyCheckKitUpdate,previewCheckKitUpdate} from '../src/kb/check-kit-update.ts';
import {readManifest,writeCheckKit} from '../src/kb/identity-core.ts';
import {vaultDisk} from './fixtures/vault-disk.mjs';

const runner = 'checks/kb-check.cjs';
const edited = 'checks/common/manifest.mjs';
const removed = 'checks/common/properties.mjs';
const added = 'checks/common/bases.mjs';
const latest = checkKitFiles();

async function fixture(t,{version='3.1.0',hasKit=true}={}) {
	const scratch = resolve('.tmp');
	await fs.mkdir(scratch,{recursive:true});
	const vault = await fs.mkdtemp(join(scratch,'check-kit-update-'));
	t.after(()=>fs.rm(vault,{recursive:true,force:true}));
	const disk = vaultDisk(vault,'.settings');
	const location = 'Libraries/新作';
	const root = join(vault,location);
	const manifestFile = join(root,'kb.toml');
	const old = {...latest,[runner]:'// installed runner\n',[edited]:'// installed manifest rule\n',[removed]:'// installed link rule\n'};
	delete old[added];
	const digests = Object.fromEntries(Object.entries(old).map(([path,content])=>[path,digest(content)]));
	const source = 'version = 2 # keep\r\n\r\n[preferences]\r\ntree = false # keep\r\n';
	const manifest = hasKit ? writeCheckKit(source,{version,protocol:1,digests}).replace('protocol = 1','protocol = 1 # keep') : source;
	async function put(path,content){
		const file = join(root,path);
		await fs.mkdir(dirname(file),{recursive:true});
		await fs.writeFile(file,content);
	}
	await put('kb.toml',manifest);
	await put('README.md','# User notes\n');
	await put('checks/personal.mjs','// template special\n');
	if (hasKit) for (const [path,content] of Object.entries(old)) await put(path,content);
	const read = path=>fs.readFile(join(root,path),'utf8');
	const preview = ()=>previewCheckKitUpdate(disk,location);
	const apply = plan=>applyCheckKitUpdate(disk,location,plan);
	return {root,disk,location,manifestFile,manifest,old,digests,put,read,preview,apply};
}

test('kit update previews the real changes and preserves locally edited or removed files',async t=>{
	const {preview,apply,root,read,old,digests,put,manifest} = await fixture(t);
	const local = '// I changed the rule\n';
	await put(edited,local);
	await fs.unlink(join(root,removed));
	const plan = await preview();
	assert.equal(plan.installedVersion,'3.1.0');
	assert.equal(plan.targetVersion,checkKitVersion);
	assert.deepEqual(Object.fromEntries(plan.files.filter(file=>file.change!=='current').map(file=>[file.path,[file.change,file.before,file.after]])),{
		[runner]:['replace',old[runner],latest[runner]],
		[edited]:['modified',local,latest[edited]],
		[removed]:['missing',undefined,latest[removed]],
		[added]:['add',undefined,latest[added]],
	});
	assert.equal(await read(runner),old[runner]);
	assert.equal(await read('kb.toml'),manifest);

	await apply(plan);
	assert.equal(await read(runner),latest[runner]);
	assert.equal(await read(edited),local);
	await assert.rejects(read(removed),{code:'ENOENT'});
	assert.equal(await read(added),latest[added]);
	assert.equal(await read('checks/personal.mjs'),'// template special\n');
	assert.equal(await read('README.md'),'# User notes\n');
	const updated = await read('kb.toml');
	assert.ok(updated.includes('protocol = 1 # keep\r\n'));
	assert.ok(updated.includes('tree = false # keep\r\n'));
	assert.deepEqual(readManifest(updated).checkKit,{version:checkKitVersion,protocol:1,digests:{
		...digests,[runner]:digest(latest[runner]),[added]:digest(latest[added]),
	}});
	assert.equal((await preview()).canApply,false);
});

test('a stale confirmation cannot replace a newly edited file or create over a newly occupied path',async t=>{
	const {apply,preview,put,read,old,manifest} = await fixture(t);
	const initial = await preview();
	await put(added,'// existing personal rule\n');
	await assert.rejects(apply(initial),/重新预览|Preview again/u);
	assert.equal(await read(runner),old[runner]);
	assert.equal(await read('kb.toml'),manifest);

	const fresh = await preview();
	await put(runner,'// replacement made after preview\n');
	await assert.rejects(apply(fresh),/重新预览|Preview again/u);
	assert.equal(await read(runner),'// replacement made after preview\n');
	assert.equal(await read(added),'// existing personal rule\n');
	assert.equal(await read('kb.toml'),manifest);
});

test('the same approved update can retry after a failed manifest replacement',async t=>{
	const {apply,preview,read,manifestFile,manifest} = await fixture(t);
	const plan = await preview();
	const rename = fs.rename;
	const failure = new Error('Interrupted before manifest publication');
	const stub = t.mock.method(fs,'rename',async (before,after)=>{
		if (after === manifestFile) throw failure;
		return rename(before,after);
	});
	syncBuiltinESMExports();
	try {await assert.rejects(apply(plan),failure);}
	finally {stub.mock.restore();syncBuiltinESMExports();}
	assert.equal(await read(runner),latest[runner]);
	assert.equal(await read('kb.toml'),manifest);
	const pendingRecord = await preview();
	assert.equal(pendingRecord.canApply,true);
	assert.ok(pendingRecord.files.every(file=>file.change==='current'));
	await apply(plan);
	assert.equal(readManifest(await read('kb.toml')).checkKit.version,checkKitVersion);
});

test('legacy libraries and newer installed kits receive no update writes',async t=>{
	const legacy = await fixture(t,{hasKit:false});
	assert.equal(await legacy.preview(),undefined);
	await assert.rejects(legacy.read(runner),{code:'ENOENT'});
	const future = await fixture(t,{version:'4.1.0'});
	const plan = await future.preview();
	assert.equal(plan.downgrade,true);
	assert.equal(plan.canApply,false);
	await assert.rejects(future.apply(plan),/重新预览|Preview again/u);
	assert.equal(await future.read(runner),future.old[runner]);
});

test('a linked directory is preserved and the update can still replace independent clean files',async t=>{
	const {root,preview,apply,read,old} = await fixture(t);
	const actual = join(root,'alternate-rules');
	const linked = join(root,'checks','common');
	await fs.rename(linked,actual);
	await fs.symlink(actual,linked,'junction');
	const plan = await preview();
	assert.equal(plan.files.find(file=>file.path===runner).change,'replace');
	assert.ok(plan.files.filter(file=>file.path!==runner).every(file=>file.change==='unavailable'));
	await apply(plan);
	assert.equal(await read(runner),latest[runner]);
	assert.equal(await fs.readFile(join(actual,'manifest.mjs'),'utf8'),old[edited]);
	await assert.rejects(fs.readFile(join(actual,'bases.mjs')),{code:'ENOENT'});
});
