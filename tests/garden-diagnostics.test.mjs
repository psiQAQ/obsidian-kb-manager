import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {templateCatalog} from '../scripts/template-catalog.mjs';
import {runDiagnostics} from '../src/diagnostics/index.ts';

const {packs, digests} = templateCatalog('assets/templates');
const pack = packs['knowledge-garden'];
const script = 'checks/workflow.mjs';
const source = 'Guides/拟分享.md';
const target = 'Drafts/同名.md';
const first = 'Libraries/甲';
const second = 'Libraries/乙';
const publish = (body, related = '[]') => `---\ntype: garden-note\nvisibility: public\npublish_ready: true\nrelated: ${related}\n---\n${body}`;
const note = visibility => `---\nvisibility: ${visibility}\n---\n# 章节\n`;

async function gardens(t) {
	const scratch = path.resolve('.tmp');
	await fs.mkdir(scratch, {recursive:true});
	const vaultRoot = await fs.mkdtemp(path.join(scratch, 'garden-diagnostics-'));
	t.after(async () => {
		assert.equal(path.dirname(path.resolve(vaultRoot)), scratch);
		await fs.rm(vaultRoot, {recursive:true, force:true});
	});
	const configDir = '.gardens-test';
	await fs.mkdir(path.join(vaultRoot, configDir));
	const put = async (instance, file, content) => {
		const filename = path.join(vaultRoot, instance, file);
		await fs.mkdir(path.dirname(filename), {recursive:true});
		await fs.writeFile(filename, content);
	};
	for (const instance of [first, second]) {
		await put(instance, 'kb.toml', 'version = 1\n');
		await put(instance, 'kb-template.json', JSON.stringify(pack.descriptor));
		await put(instance, script, pack.text[script]);
	}
	const run = async (instance, overrides = {}) => (await runDiagnostics({libraryRoot:path.join(vaultRoot, instance), vaultRoot, configDir,
		selected:['workflow'], officialDigests:digests, nodeExecutable:process.execPath, ...overrides})).checks[0];
	return {put, run};
}

test('garden classifies the actual target of same-name references across instances', async t => {
	const {put, run} = await gardens(t);
	for (const instance of [first, second]) await put(instance, source, publish('[[同名#章节|摘录]]', '["[[同名]]"]'));
	await put(first, target, note('private'));
	await put(second, target, note('public'));
	const options = {
		collectLinks: file => file.endsWith('/' + source) ? [
			{target:'同名#章节', kind:'link', syntax:'wiki', line:7}, {target:'同名', kind:'link'},
		] : [],
		resolveLink: ({source:file, target:short}) => {
			assert.equal(short, '同名');
			return {status:'resolved', path:`${file.startsWith(first + '/') ? second : first}/${target}`};
		},
		linkTargetVisibility: file => {
			assert.ok(file === `${first}/${target}` || file === `${second}/${target}`);
			return file.startsWith(first + '/') ? 'private' : 'public';
		},
	};
	const safe = await run(first, options);
	assert.equal(safe.status, 'passed', JSON.stringify(safe));
	assert.deepEqual(safe.diagnostics, []);
	const unsafe = await run(second, options);
	assert.equal(unsafe.status, 'findings');
	assert.deepEqual(unsafe.diagnostics.map(({file, line, severity, code, evidence}) => [file, line, severity, code, evidence]),
		[[source, 7, 'warning', 'sharing-private-reference', `${first}/${target}`]]);
	const unknown = await run(second, {...options, linkTargetVisibility:() => undefined});
	assert.equal(unknown.status, 'partial');
	assert.equal(unknown.coverage.unknown, 1);
	assert.deepEqual(unknown.diagnostics.map(({code}) => code), ['sharing-reference-unverified']);
});

test('garden reports unverified offline short links and confirms explicit private note paths', async t => {
	const {put, run} = await gardens(t);
	await put(first, target, note('private'));
	await put(second, target, note('public'));
	await put(first, source, publish('[提纲](../Drafts/同名.md#章节)\n`[[行内示例]]`\n```md\n[[代码示例]]\n```', '["[[同名]]"]'));
	const mixed = await run(first);
	assert.equal(mixed.status, 'partial', JSON.stringify(mixed));
	assert.equal(mixed.coverage.unknown, 1);
	assert.deepEqual(mixed.diagnostics.map(({code, evidence}) => [code, evidence]), [
		['sharing-private-reference', `${first}/${target}`], ['sharing-reference-unverified', '同名'],
	]);
	await put(first, source, publish('[[同名]]'));
	const unresolved = await run(first);
	assert.equal(unresolved.status, 'partial');
	assert.deepEqual(unresolved.diagnostics.map(({code}) => code), ['sharing-reference-unverified']);
});

test('a locally changed garden checker needs approval before collecting link evidence', async t => {
	const {put, run} = await gardens(t);
	await put(first, source, publish('[[同名]]'));
	const modified = pack.text[script] + '\n// local change';
	await put(first, script, modified);
	let collected = 0;
	const options = {collectLinks: () => {collected++; return [];}};
	const rejected = await run(first, options);
	assert.deepEqual(rejected.diagnostics.map(({code}) => code), ['checker-untrusted']);
	assert.equal(collected, 0);
	const accepted = await run(first, {...options, trustedDigests:[createHash('sha256').update(modified).digest('hex')]});
	assert.equal(accepted.status, 'passed', JSON.stringify(accepted));
	assert.ok(collected > 0);
});
