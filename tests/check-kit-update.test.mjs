import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {runDiagnostics} from '../src/diagnostics/index.ts';
import {digest} from '../src/fs/vault.ts';
import {checkKitFiles,checkKitVersion} from '../src/kb/check-kit.ts';
import {applyCheckKitUpdate,previewCheckKitUpdate} from '../src/kb/check-kit-update.ts';
import {previousCourseworkDigests} from '../src/kb/coursework-check.ts';
import {readManifest,writeCheckKit,writeIdentity} from '../src/kb/identity-core.ts';
import {officialCheckDigests,packText} from '../src/kb/template-pack.ts';
import {vaultDisk} from './fixtures/vault-disk.mjs';

const runner = 'checks/kb-check.cjs';
const edited = 'checks/common/manifest.mjs';
const removed = 'checks/common/properties.mjs';
const added = 'checks/common/bases.mjs';
const latest = checkKitFiles();
const coursework = 'checks/workflow.mjs';
const declaration = 'kb-template.json';
const assignment = 'Courses/实验入门/Assignments/图表作业.md';
const course = 'Courses/实验入门/课程索引.md';
// Bundled template scripts were installed with LF on every platform.
const originalCoursework = (await fs.readFile(new URL('./fixtures/coursework-v1.mjs',import.meta.url),'utf8')).replace(/\r\n/gu,'\n');

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

async function courseworkFixture(t) {
	const item = await fixture(t);
	const raw = writeIdentity(item.manifest,{schemaVersion:2,id:'4d29d18b-6d25-4099-9a94-e44d4c652300',
		displayName:'Course test',description:'',archived:false,template:{id:'coursework',version:'1'},managed:[]});
	await item.put('kb.toml',raw);
	const before = '{\r\n  "id": "coursework", "version": "1", "name": "我的课程",\r\n  "checks": [\r\n' +
		'    {"id": "personal", "name": "Personal", "path": "checks/personal.mjs"},\r\n' +
		'    {\r\n      "id": "workflow",\r\n      "name": "有效课程和截止日",\r\n      "path": "checks/workflow.mjs"\r\n    }\r\n  ]\r\n}\r\n';
	await item.put(declaration,before);
	await item.put(coursework,originalCoursework);
	await item.put(course,'---\ntype: course\n---\n# Course\n');
	return {...item,raw,before};
}

const assignmentSource = (courseLink, due) => `---\ntype: assignment\nstatus: scheduled\ncourse: ${JSON.stringify(courseLink)}\ndue: ${due}\n---\n`;
const courseworkChanges = plan => Object.fromEntries(plan.courseworkFiles.map(file => [file.path,file.change]));

test('kit update previews the real changes and preserves locally edited or removed files',async t=>{
	const {preview,apply,root,read,old,digests,put,manifest} = await fixture(t,{version:'3.3.0'});
	const local = '// I changed the rule\n';
	await put(edited,local);
	await fs.unlink(join(root,removed));
	const plan = await preview();
	assert.equal(plan.installedVersion,'3.3.0');
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

test('reviewed coursework update preserves declaration bytes, trusts the fixed bytes and works offline and with desktop link evidence',async t=>{
	const {root,disk,location,preview,apply,read,put,before} = await courseworkFixture(t);
	assert.equal(digest(originalCoursework),previousCourseworkDigests[0]);
	const plan = await preview();
	assert.deepEqual(courseworkChanges(plan),{[coursework]:'replace',[declaration]:'replace'});
	assert.equal(await read(declaration),before);
	await apply(plan);
	const source = await read(coursework);
	assert.equal(source,packText('coursework')[coursework]);
	assert.ok(officialCheckDigests().includes(digest(source)));
	assert.equal(await read(declaration),before.replace('"path": "checks/workflow.mjs"',
		'"path": "checks/workflow.mjs",\r\n      "linkEvidence": true'));
	const {checkKit,identity} = readManifest(await read('kb.toml'));
	assert.deepEqual(identity.template,{id:'coursework',version:'1'});
	assert.equal(checkKit.version,checkKitVersion);
	assert.equal(checkKit.digests[coursework],undefined);
	assert.equal((await preview()).canApply,false);

	await put(assignment,assignmentSource('[[../课程索引]]','2026-09-15'));
	const run = promisify(execFile);
	const offline = async () => {
		const {stdout} = await run(process.execPath,[join(root,runner),'--library',root,'--vault-root',disk.root,'--checks','workflow']);
		const report = JSON.parse(stdout);
		assert.equal(report.environment,'offline');
		return report.checks[0];
	};
	const desktop = async found => {
		const report = await runDiagnostics({libraryRoot:root,vaultRoot:disk.root,nodeExecutable:process.execPath,
			selected:['workflow'],officialDigests:officialCheckDigests(),resolveLink:() => found});
		assert.equal(report.environment,'desktop');
		return report.checks[0];
	};
	assert.equal((await offline()).status,'passed');
	assert.equal((await desktop({status:'resolved',path:location+'/'+course})).status,'passed');
	assert.deepEqual((await desktop({status:'resolved',path:'Other/'+course})).diagnostics.map(item => item.code),['assignment-course-invalid']);

	await put(assignment,assignmentSource('[[../没有该课]]','2026-02-30'));
	assert.deepEqual((await offline()).diagnostics.map(item => item.code),['assignment-course-missing','assignment-due-invalid']);
	await put(assignment,assignmentSource('[[课程索引]]','2026-02-30'));
	const unknown = await offline();
	assert.equal(unknown.status,'partial');
	assert.deepEqual(unknown.diagnostics.map(({code,severity}) => [code,severity]),[
		['assignment-course-unverified','info'],['assignment-due-invalid','warning'],
	]);
});

test('edited or missing coursework files block their companion and do not prevent independent check kit updates',async t=>{
	const {apply,preview,put,read,before,root} = await courseworkFixture(t);
	const reviewed = await preview();
	const editedSource = originalCoursework + '// user edit\n';
	await put(coursework,editedSource);
	await assert.rejects(apply(reviewed),/重新预览|Preview again/u);
	const plan = await preview();
	assert.deepEqual(courseworkChanges(plan),{[coursework]:'modified',[declaration]:'blocked'});
	await apply(plan);
	assert.equal(await read(coursework),editedSource);
	assert.equal(await read(declaration),before);
	assert.equal(await read(runner),latest[runner]);
	await put(coursework,originalCoursework);
	await put(declaration,before.replace('有效课程和截止日','我的规则'));
	assert.deepEqual(courseworkChanges(await preview()),{[coursework]:'blocked',[declaration]:'modified'});
	await fs.unlink(join(root,declaration));
	assert.deepEqual(courseworkChanges(await preview()),{[coursework]:'blocked',[declaration]:'missing'});
});

test('coursework pair rolls back its script on declaration failure, and a stale retry preserves a concurrent script edit',async t=>{
	const {root,preview,apply,read,put,before,raw} = await courseworkFixture(t);
	const plan = await preview();
	const rename = fs.rename;
	const failure = new Error('Course declaration publication rejected');
	async function interrupt(beforeFailure) {
		const stub = t.mock.method(fs,'rename',async (from,to) => {
			if (to === join(root,declaration)) {
				await beforeFailure();
				throw failure;
			}
			return rename(from,to);
		});
		syncBuiltinESMExports();
		try { await assert.rejects(apply(plan),failure); }
		finally { stub.mock.restore(); syncBuiltinESMExports(); }
	}
	await interrupt(() => {});
	assert.equal(await read(coursework),originalCoursework);
	assert.equal(await read(declaration),before);
	assert.equal(await read('kb.toml'),raw);
	assert.equal(await read(runner),latest[runner]);

	const userEdit = '// Edited during apply\n';
	await interrupt(() => put(coursework,userEdit));
	assert.equal(await read(coursework),userEdit);
	assert.equal(await read(declaration),before);
	await assert.rejects(apply(plan),/重新预览|Preview again/u);

	// Equivalent to an interrupted process after publishing the script, with the manifest still pending.
	await put(coursework,packText('coursework')[coursework]);
	assert.deepEqual(courseworkChanges(await preview()),{[coursework]:'current',[declaration]:'replace'});
	await apply(plan);
	assert.equal((await preview()).canApply,false);
});
