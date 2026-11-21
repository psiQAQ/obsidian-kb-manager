import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { templateCatalog } from '../scripts/template-catalog.mjs';
import { digest, VaultDisk } from '../src/fs/vault.ts';
import { discover } from '../src/kb/catalog.ts';
import { parseIdentity, readManifest, writeIdentity } from '../src/kb/identity-core.ts';
import { declaration } from '../src/kb/template-declaration.ts';
import { registerVaultLibrary } from '../src/registry/discovery.ts';

const { packs, digests } = templateCatalog(resolve('assets/templates'));
global.KB_TEMPLATE_PACKS = packs;
global.KB_CHECK_DIGESTS = digests;
const { applyUpgradeChecks, previewUpgradeChecks } = await import('../src/kb/upgrade-checks.ts');
const { applyManifestUpgrade, previewManifestUpgrade } = await import('../src/kb/manifest-upgrade.ts');

async function fixture(t, initial = {}) {
	const scratch = resolve('.tmp');
	await mkdir(scratch, {recursive:true});
	const vault = await mkdtemp(join(scratch, 'upgrade-checks-'));
	t.after(() => rm(vault, {recursive:true,force:true}));
	const location = 'Knowledge/旧库';
	const root = join(vault, location);
	await mkdir(root, {recursive:true});
	const identity = {schemaVersion:1,id:'d553c466-d2ab-4285-affa-40f3148be13b',displayName:'真实旧库',description:'保留内容',archived:false,
		template:{id:'kepano',version:'3'},managed:[],entry:'README.md',...initial};
	const manifest = writeIdentity('version = 1 # preserve\n[preferences]\ntree = false\n', identity);
	await writeFile(join(root, 'kb.toml'), manifest);
	await writeFile(join(root, 'README.md'), '# 原有首页\n');
	return {root,disk:new VaultDisk(vault, '.settings'),library:{location,identity:parseIdentity(manifest),git:'local'},manifest};
}

test('preview publishes the current official checks with the old version and available mapped paths', async t => {
	const {root,disk,library,manifest} = await fixture(t, {template:{id:'llm-wiki',version:'2'},entry:'访问入口.md'});
	library.mapping = {wiki:'知识页',index:'知识页/index.md',templates:'本库模板'};
	await mkdir(join(root, '本库模板'));
	await writeFile(join(root, '访问入口.md'), '历史入口\n');
	const before = await readdir(root);
	const plan = await previewUpgradeChecks(disk,library);
	assert.deepEqual(await readdir(root),before);
	assert.deepEqual(plan.manual, []);
	assert.deepEqual(plan.files.map(item=>item.path), ['checks/analysis-evidence.mjs','kb-template.json']);
	const [script,spec] = plan.files;
	assert.ok(digests.includes(script.fingerprint));
	assert.equal(digest(script.content),script.fingerprint);
	const parsed = declaration(spec.content);
	assert.equal(parsed.version,'2');
	assert.equal(parsed.id,'llm-wiki');
	assert.equal(parsed.entry,'访问入口.md');
	assert.deepEqual(parsed.pageTemplates,['本库模板']);
	assert.equal(parsed.text,undefined);
	assert.equal(parsed.paths,undefined);
	await applyUpgradeChecks(disk,library,plan);
	assert.equal(await readFile(join(root,script.path),'utf8'),script.content);
	assert.equal(await readFile(join(root,spec.path),'utf8'),spec.content);
	assert.equal(await readFile(join(root,'kb.toml'),'utf8'),manifest);
	assert.equal(await readFile(join(root,'访问入口.md'),'utf8'),'历史入口\n');
});

test('unknown versions and modern libraries offer only the existing general upgrade', async t => {
	const {root,disk,library} = await fixture(t,{template:{id:'kepano',version:'2.1'}});
	for (const identity of [library.identity,{...library.identity,schemaVersion:2,template:{id:'kepano',version:'3'}},
		{...library.identity,template:{id:'personal',version:'1'}}]) {
		const candidate = {...library,identity};
		const plan = await previewUpgradeChecks(disk,candidate);
		assert.deepEqual(plan,{location:library.location,files:[],manual:[]});
		await applyUpgradeChecks(disk,candidate,plan);
		assert.deepEqual((await readdir(root)).sort(),['README.md','kb.toml']);
	}
});

test('an existing personal declaration or script prevents all automatic writes', async t => {
	const first = await fixture(t);
	const custom = '{"id":"personal","checks":[]}\n';
	await writeFile(join(first.root,'kb-template.json'),custom);
	const firstPlan = await previewUpgradeChecks(first.disk,first.library);
	assert.deepEqual(firstPlan.files,[]);
	assert.ok(firstPlan.manual.some(line=>line.includes('kb-template.json')));
	await applyUpgradeChecks(first.disk,first.library,firstPlan);
	assert.equal(await readFile(join(first.root,'kb-template.json'),'utf8'),custom);
	assert.ok(!(await readdir(first.root)).includes('checks'));

	const second = await fixture(t);
	await mkdir(join(second.root,'checks'));
	const code = 'export default () => []\n';
	const file = join(second.root,'checks','category-links.mjs');
	await writeFile(file,code);
	const secondPlan = await previewUpgradeChecks(second.disk,second.library);
	assert.ok(secondPlan.manual.some(line=>line.includes('category-links.mjs')));
	await applyUpgradeChecks(second.disk,second.library,secondPlan);
	assert.equal(await readFile(file,'utf8'),code);
	assert.ok(!(await readdir(second.root)).includes('kb-template.json'));
});

test('same-byte interrupted or completed writes are retryable while an external edit requires fresh preview', async t => {
	const {root,disk,library} = await fixture(t);
	const original = await previewUpgradeChecks(disk,library);
	const [script,spec] = original.files;
	await assert.rejects(applyUpgradeChecks(disk,{...library,location:'Knowledge/他库'},original));
	await mkdir(join(root,'checks'));
	await writeFile(join(root,script.path),script.content);
	const resumed = await previewUpgradeChecks(disk,library);
	assert.equal(resumed.files[0].existing,true);
	assert.equal(resumed.files[1].existing,false);
	await applyUpgradeChecks(disk,library,original);
	await applyUpgradeChecks(disk,library,original);
	assert.equal(await readFile(join(root,spec.path),'utf8'),spec.content);
	const stable = await previewUpgradeChecks(disk,library);
	assert.ok(stable.files.every(file=>file.existing));

	const drift = await fixture(t);
	const preview = await previewUpgradeChecks(drift.disk,drift.library);
	await mkdir(join(drift.root,'checks'));
	await writeFile(join(drift.root,script.path),script.content.replace(/[^\n]/u,'X'));
	await assert.rejects(applyUpgradeChecks(drift.disk,drift.library,preview));
	assert.ok(!(await readdir(drift.root)).includes('kb-template.json'));
});

test('case-ambiguous checks directory is left for manual handling', async t => {
	const {root,disk,library} = await fixture(t);
	await mkdir(join(root,'Checks'));
	const plan = await previewUpgradeChecks(disk,library);
	assert.deepEqual(plan.files,[]);
	assert.ok(plan.manual.some(line=>line.includes('checks/category-links.mjs')));
	assert.ok(!(await readdir(root)).includes('kb-template.json'));
});

async function registeredUpgrade(t) {
	const {root,disk,library,manifest} = await fixture(t);
	const original = manifest.replace('version = 1 # preserve\n', 'version = 1 # preserve\nowner = "社区"\n')
		.replace('tree = false\n', 'tree = false\ncustom-preference = "保留"\n');
	const manifestPath = await disk.path(library.location + '/kb.toml');
	await writeFile(manifestPath,original);
	const ignorePath = join(root,'.gitignore');
	const originalIgnore = '# 旧规则\r\n/local-notes/\r\n';
	await writeFile(ignorePath,originalIgnore);
	const config = {parents:['Knowledge'],templates:[]};
	await registerVaultLibrary(disk,config,library.location);
	const [registered] = await discover(disk,config);
	const preview = await previewManifestUpgrade(disk,registered);
	assert.ok(preview);
	assert.equal(preview.log.exists,false);
	assert.equal(preview.ignores.before,originalIgnore);
	assert.deepEqual(preview.checks.files.map(file => file.path),['checks/category-links.mjs','kb-template.json']);
	assert.deepEqual((await readdir(root)).sort(),['.gitignore','README.md','kb.toml']);
	return {root,manifestPath,original,ignorePath,originalIgnore,preview,apply:() => applyManifestUpgrade(disk,config,preview)};
}

async function failManifestRename(t, {manifestPath,apply}, beforeFailure = async () => {}) {
	const failure = new Error('Injected failure replacing kb.toml');
	const rename = fs.rename;
	const stub = t.mock.method(fs,'rename',async (from,to) => {
		if (to !== manifestPath) return rename(from,to);
		await beforeFailure(from);
		throw failure;
	});
	syncBuiltinESMExports();
	try { await assert.rejects(apply(), failure); }
	finally { stub.mock.restore(); syncBuiltinESMExports(); }
}

test('the same confirmed upgrade retries a failed final manifest replacement', async t => {
	const upgrade = await registeredUpgrade(t);
	const {root,manifestPath,original,ignorePath,originalIgnore,preview,apply} = upgrade;
	const expectedIgnore = originalIgnore + '/.log/\r\n/kb.toml\r\n';
	const expectedManifest = original.replace('version = 1 # preserve','version = 2 # preserve')
		.replace(/^schemaVersion = 1$/mu,'schemaVersion = 2');
	await failManifestRename(t,upgrade,async temporary => {
		assert.equal(await readFile(temporary,'utf8'),expectedManifest);
		assert.equal(await readFile(manifestPath,'utf8'),original);
		assert.equal(await readFile(ignorePath,'utf8'),expectedIgnore);
		assert.deepEqual(await readdir(join(root,'.log')),[]);
		for (const file of preview.checks.files) assert.equal(await readFile(join(root,file.path),'utf8'),file.content);
	});
	assert.equal(await readFile(manifestPath,'utf8'),original);
	assert.ok(!(await readdir(root)).some(name => name.startsWith('.kb-manifest-')));
	const userLog = join(root,'.log','my-notes.log');
	await writeFile(userLog,'用户笔记\n');

	await apply();
	const manifest = await readFile(manifestPath,'utf8');
	assert.equal(manifest,expectedManifest);
	assert.equal(parseIdentity(manifest).schemaVersion,2);
	assert.equal(parseIdentity(manifest).id,parseIdentity(original).id);
	assert.deepEqual(readManifest(manifest).preferences,{tree:false});
	assert.equal(await readFile(ignorePath,'utf8'),expectedIgnore);
	assert.equal(await readFile(userLog,'utf8'),'用户笔记\n');
	assert.equal(await readFile(join(root,'README.md'),'utf8'),'# 原有首页\n');
	for (const file of preview.checks.files) assert.equal(await readFile(join(root,file.path),'utf8'),file.content);
});

test('retry preserves user edits and rejects a stale confirmation', async t => {
	const edits = [
		['.gitignore', before => before + '/my-notes/\r\n', /忽略规则已变化|Ignore rules changed/u],
		['checks/category-links.mjs', before => before + '// User code\n', /专项文件预览已变化|A check file changed/u],
		['kb-template.json', before => JSON.stringify({...JSON.parse(before),name:'用户模板'},null,2) + '\n', /专项文件预览已变化|A check file changed/u],
		['kb.toml', before => before + '# User edit\n', /知识库已变化|Library changed/u],
	];
	for (const [name,edit,error] of edits) await t.test(name,async subtest => {
		const upgrade = await registeredUpgrade(subtest);
		await failManifestRename(subtest,upgrade);
		const path = join(upgrade.root,name);
		const after = edit(await readFile(path,'utf8'));
		await writeFile(path,after);

		await assert.rejects(upgrade.apply(),error);
		assert.equal(await readFile(path,'utf8'),after);
		assert.equal(await readFile(upgrade.manifestPath,'utf8'),name === 'kb.toml' ? after : upgrade.original);
	});
});
