import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { readManifest, writeIdentity } from '../src/kb/identity-core.ts';
import { bindSharedKepanoPage, rebindKepano } from '../src/kb/kepano.ts';
import { builtinTemplate, kepanoBindingAssets, kepanoTemplate } from '../src/kb/template-core.ts';
import { checkTemplateFile, legacyTemplateFolder, listTemplateFiles, localTemplateFolder,
	previewTemplateRestore, restoredTemplateBindings, restoreTemplateFile } from '../src/kb/template-files.ts';

async function assets(root) {
	const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
	return Object.fromEntries(await Promise.all(files.map(async entry => {
		const name = join(entry.parentPath, entry.name);
		return [relative(root, name).replaceAll('\\', '/'), await readFile(name, 'utf8')];
	})));
}

function fixture() {
	const root = 'Libraries/QA';
	const files = new Map([
		[root + '/kb.toml', 'manifest'],
		['.settings/templates.json', '{"folder":"Existing/Shared"}'],
		['.settings/app.json', '{"userIgnoreFilters":["Existing/Shared/"]}'],
	]);
	const dirs = new Set(['', 'Libraries', root, '.settings', 'Existing', 'Existing/Shared']);
	const parent = path => path.slice(0, Math.max(0, path.lastIndexOf('/')));
	const disk = {
		async stat(path) { return files.has(path) ? { type: 'file' } : dirs.has(path) ? { type: 'folder' } : null; },
		async list(path) {
			assert.ok(dirs.has(path), 'Expected folder: ' + path);
			return { files: [...files.keys()].filter(file => parent(file) === path),
				folders: [...dirs].filter(dir => dir && parent(dir) === path) };
		},
		async mkdir(path) {
			assert.ok(!files.has(path) && !dirs.has(path) && dirs.has(parent(path)));
			dirs.add(path);
		},
		async read(path) { return files.get(path); },
		async write(path, content) {
			assert.ok(dirs.has(parent(path)));
			files.set(path, content);
		},
		async copy(from, to) {
			if (files.has(to) || dirs.has(to)) throw new Error('Destination exists');
			await this.write(to, await this.read(from));
		},
		async remove(path) { assert.ok(files.delete(path)); },
	};
	return { root, access: { disk, configDir: '.settings' }, files, dirs };
}

const [wiki, kepano] = await Promise.all([assets('assets/llm-wiki'), assets('assets/kepano')]);
const identity = {
	schemaVersion: 1, id: '41058c33-9509-450f-9d8f-a59c9d0d9b5a', displayName: 'QA',
	description: '', archived: false, managed: [],
};

test('v3 builds complete local templates while v2 Fusion accepts its original paths without templates', () => {
	const root = 'Libraries/QA';
	const fusion = builtinTemplate(wiki, { displayName: 'QA', description: '', destination: root });
	const personal = kepanoTemplate(kepano, root);
	const names = template => template.files.map(file => file.name);
	assert.equal(fusion.version, '3');
	assert.equal(personal.version, '3');
	assert.equal(names(fusion).filter(name => /^templates\/.+\.md$/u.test(name)).length, 6);
	assert.equal(names(fusion).filter(name => /^templates\/.+\.base$/u.test(name)).length, 1);
	assert.equal(names(personal).filter(name => /^Templates\/.+\.md$/u.test(name)).length, 52);
	assert.equal(names(personal).filter(name => /^Templates\/.+\.base$/u.test(name)).length, 30);
	assert.ok(!names(personal).some(name => name.startsWith('README.v')));
	const old = wiki['kb.toml'].replace(/^templates = .*\r?\n/mu, '');
	const v2 = { ...identity, template: { id: 'llm-wiki', version: '2' } };
	const block = writeIdentity('', v2).replace(/^version = 1\n/u, '');
	const manifest = old + '\n' + block;
	assert.equal(readManifest(manifest).mapping.templates, undefined);
	assert.equal(localTemplateFolder(root, 'llm-wiki', readManifest(manifest).mapping), root + '/templates');
	assert.throws(() => readManifest(manifest.replace('version = "2"', 'version = "3"')), /templates/u);
});

test('uses existing v2 shared inputs and restores only missing Fusion files inside the library', async () => {
	const { root, access, files, dirs } = fixture();
	const shared = 'Existing/Shared/融合 LLM Wiki';
	dirs.add(shared);
	const missingName = '知识页面模板.md';
	files.set(shared + '/人工笔记模板.md', 'edited shared input');
	const local = root + '/templates';
	dirs.add(local);
	files.set(local + '/分类入口模板.md', 'edited local input');
	const before = new Map(files);
	assert.equal(await legacyTemplateFolder(access, 'llm-wiki'), shared);
	const available = await listTemplateFiles(access, shared, '');
	const plan = await previewTemplateRestore(access, 'llm-wiki', root, local, wiki, available);
	assert.equal(plan.length, 5);
	assert.ok(plan.some(item => item.path === local + '/Bases/分类专用模板.base'));
	assert.deepEqual(files, before);
	for (const item of plan) await restoreTemplateFile(access, item, root);
	assert.ok([...files.keys()].every(path => before.has(path) || path.startsWith(local + '/')));
	for (const [path, content] of before) assert.equal(files.get(path), content);
	assert.equal(files.get(local + '/' + missingName), wiki['templates/' + missingName]);
	assert.deepEqual(await previewTemplateRestore(access, 'llm-wiki', root, local, wiki, available), []);
});

test('Kepano restoration binds bundled links while insertion preserves edits to legacy source values', async () => {
	const { root, access, files, dirs } = fixture();
	const local = root + '/Templates';
	const plan = await previewTemplateRestore(access, 'kepano', root, local, kepano, new Set(['Book Template.md']));
	assert.equal(plan.length, 81);
	assert.ok(!plan.some(item => item.path === local + '/Book Template.md'));
	const actor = plan.find(item => item.path === local + '/Actor Template.md');
	assert.match(actor.content, /\[\[Libraries\/QA\/Categories\/People\]\]/u);
	await restoreTemplateFile(access, actor, root);
	await assert.rejects(restoreTemplateFile(access, actor, root));
	assert.equal(files.get(actor.path), actor.content);
	const v2 = { ...identity, template: { id: 'kepano', version: '2' } };
	const bindings = await restoredTemplateBindings(v2, [actor], root, kepano, async () => 'hash');
	assert.deepEqual(bindings, [{ path: actor.bundledPath, root, fingerprint: 'hash', role: 'kepano-bindings' }]);
	const old = kepano[actor.bundledPath].replaceAll('__KB_ROOT__/', '')
		.replace('[[References/Actors]]', '[[Private/Cast]]') + '\nOriginal user edit\n';
	const inserted = bindSharedKepanoPage('Actor Template.md', old, root, kepano);
	assert.ok(inserted.includes('[[Private/Cast]]') && inserted.includes('Original user edit'));
	assert.ok(inserted.includes('![[' + root + '/Templates/Bases/Movies.base#Actor]]'));
	assert.ok(!inserted.includes('__KB_ROOT__'));
	dirs.add('Existing/Shared/Kepano');
	files.set('Existing/Shared/Kepano/.git', 'nested boundary');
	await assert.rejects(legacyTemplateFolder(access, 'kepano'));
	await assert.rejects(checkTemplateFile(access, 'Existing/Shared/Kepano/Actor Template.md', ''));
});

test('historical Kepano README uses its own declared paths for maintenance', () => {
	for (const version of ['1', '2', '3']) {
		const skeleton = kepanoBindingAssets(kepano, version);
		const old = skeleton['README.md'].replaceAll('__KB_ROOT__', 'Libraries/Old');
		const moved = rebindKepano('README.md', old, 'Libraries/Old', 'New/Here', skeleton);
		assert.deepEqual(moved.manual, []);
		assert.equal(moved.content, old.replaceAll('Libraries/Old', 'New/Here'));
	}
});
