import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { templateCatalog } from '../scripts/template-catalog.mjs';
import { digest, VaultDisk } from '../src/fs/vault.ts';
import { parseIdentity, writeIdentity } from '../src/kb/identity-core.ts';
import { declaration } from '../src/kb/template-declaration.ts';

const { packs, digests } = templateCatalog(resolve('assets/templates'));
global.KB_TEMPLATE_PACKS = packs;
global.KB_CHECK_DIGESTS = digests;
const { applyUpgradeChecks, previewUpgradeChecks } = await import('../src/kb/upgrade-checks.ts');

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
