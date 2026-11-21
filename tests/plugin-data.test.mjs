import assert from 'node:assert/strict';
import test from 'node:test';
import { readPendingLibraryPreferences } from '../src/preferences.ts';
import { PluginDataRegistry } from '../src/registry/plugin-data.ts';

const configDir = '.settings';

function fixture({data = null, legacy = null} = {}) {
	const persisted = {data,legacy};
	const pluginData = {
		async load() { return structuredClone(persisted.data); },
		async save(next) { persisted.data = structuredClone(next); },
	};
	const legacyFile = {
		async read() { return persisted.legacy; },
		async remove(expected) {
			assert.equal(persisted.legacy,expected);
			persisted.legacy = null;
		},
	};
	const registry = new PluginDataRegistry(configDir,pluginData,legacyFile);
	return {registry,persisted,pluginData,legacyFile};
}

test('simultaneous preference and registry writes preserve each other and unrelated fields',async()=>{
	const {registry,persisted} = fixture({data:{language:'system',defaults:{},extension:{enabled:true}}});
	await Promise.all([
		registry.update(paths=>[...paths,'Books/Alpha']),
		registry.savePreferences({language:'zh',defaults:{tree:true}}),
		registry.update(paths=>[...paths,'Books/β']),
	]);
	assert.deepEqual(persisted.data,{
		language:'zh',defaults:{tree:true},extension:{enabled:true},registeredLibraries:['Books/Alpha','Books/β'],
	});
	assert.deepEqual((await registry.read()).paths,['Books/Alpha','Books/β']);
});

test('retired device data and legacy preferences do not replace or leak into the path registry',async()=>{
	const id = '10000000-0000-4000-8000-000000000001';
	const oldData = {
		language:'en',defaults:{tree:true},libraries:{[id]:{historyDate:false,author:'private',email:'author@example.invalid'}},
		parents:['Books'],templates:['Templates'],grants:{[id]:{url:'https://private.example.invalid/library'}},
		moves:{[id]:{location:'Old'}},saves:{[id]:{message:'private'}},known:{[id]:'Books/Library'},
		pendingLibraryPreferences:{[id]:{showStatusBar:false}},author:'private',email:'author@example.invalid',
		extension:{author:'keep this separate value'},
	};
	const legacy = '["Books/Library"]';
	const {registry,persisted} = fixture({data:oldData,legacy});
	assert.deepEqual(readPendingLibraryPreferences(undefined,oldData),{[id]:{historyDate:false}});
	assert.deepEqual((await registry.read()).paths,['Books/Library']);
	await registry.savePreferences({language:'zh',defaults:{tree:false}});
	assert.deepEqual(persisted.data,{language:'zh',defaults:{tree:false},extension:{author:'keep this separate value'}});
	assert.equal(persisted.legacy,legacy);
	assert.deepEqual((await registry.read()).paths,['Books/Library']);
});

test('plugin data takes precedence even for an empty list, and explicit migration merges paths once',async()=>{
	const legacy = '["Books/Shared","Missing/Old"]\n';
	const {registry,persisted} = fixture({legacy,data:{language:'en',defaults:{tree:true},registeredLibraries:[]}});
	assert.deepEqual((await registry.read()).paths,[]);
	persisted.data.registeredLibraries = ['Books/Shared','Books/New'];
	assert.deepEqual((await registry.read()).paths,['Books/New','Books/Shared']);
	const preview = await registry.previewMigration();
	assert.deepEqual(preview.currentPaths,['Books/New','Books/Shared']);
	assert.deepEqual(preview.legacyPaths,['Books/Shared','Missing/Old']);
	assert.deepEqual(preview.paths,['Books/New','Books/Shared','Missing/Old']);
	assert.equal(persisted.legacy,legacy);
	await assert.rejects(async()=>registry.assertWritable());
	await registry.savePreferences({language:'zh',defaults:{tree:true}});
	await registry.migrate(preview);
	assert.deepEqual(persisted.data,{
		language:'zh',defaults:{tree:true},registeredLibraries:['Books/New','Books/Shared','Missing/Old'],
	});
	assert.equal(persisted.legacy,null);
	assert.ok(!(await registry.previewMigration()));
});

test('migration rejects a preview if legacy bytes or the destination registrations changed',async()=>{
	const legacy = '["Books/Legacy"]';
	const data = {registeredLibraries:['Books/Current']};
	const {registry,persisted} = fixture({data,legacy});
	const preview = await registry.previewMigration();
	persisted.legacy = legacy+'\n';
	await assert.rejects(registry.migrate(preview));
	assert.equal(persisted.legacy,legacy+'\n');
	assert.deepEqual(persisted.data,data);
	const refreshed = await registry.previewMigration();
	persisted.data = {registeredLibraries:['Books/New']};
	await assert.rejects(registry.migrate(refreshed));
	assert.equal(persisted.legacy,legacy+'\n');
	assert.deepEqual(persisted.data,{registeredLibraries:['Books/New']});
});

test('a rejected save and missing write readback both keep the legacy register available for retry',async t=>{
	const original = {language:'en',defaults:{tree:true}};
	const legacy = '["Books/Legacy"]';
	const {registry,persisted,pluginData,legacyFile} = fixture({data:original,legacy});
	const deleteFile = t.mock.method(legacyFile,'remove');
	const failure = t.mock.method(pluginData,'save',async()=>{throw new Error('injected save failure');});
	await assert.rejects(registry.migrate(await registry.previewMigration()),/injected save failure/u);
	failure.mock.restore();
	assert.equal(persisted.legacy,legacy);
	assert.deepEqual(persisted.data,original);
	const droppedWrite = t.mock.method(pluginData,'save',async()=>{});
	await assert.rejects(registry.migrate(await registry.previewMigration()));
	droppedWrite.mock.restore();
	assert.equal(deleteFile.mock.callCount(),0);
	assert.equal(persisted.legacy,legacy);
	assert.deepEqual((await registry.read()).paths,['Books/Legacy']);
	await registry.migrate(await registry.previewMigration());
	assert.equal(deleteFile.mock.callCount(),1);
	assert.deepEqual(persisted.data,{...original,registeredLibraries:['Books/Legacy']});
	assert.equal(persisted.legacy,null);
});

test('retrying an interrupted cleanup keeps the verified paths and removes the old file once',async t=>{
	const legacy = '["Books/Legacy","Books/Shared"]';
	const {registry,persisted,legacyFile} = fixture({data:{registeredLibraries:['Books/Shared']},legacy});
	const expected = ['Books/Legacy','Books/Shared'];
	const failure = t.mock.method(legacyFile,'remove',async raw=>{
		assert.equal(raw,legacy);
		assert.deepEqual(persisted.data.registeredLibraries,expected);
		throw new Error('injected cleanup failure');
	});
	await assert.rejects(registry.migrate(await registry.previewMigration()),/injected cleanup failure/u);
	failure.mock.restore();
	assert.equal(persisted.legacy,legacy);
	assert.deepEqual((await registry.read()).paths,expected);
	await registry.migrate(await registry.previewMigration());
	assert.equal(persisted.legacy,null);
	assert.deepEqual(persisted.data.registeredLibraries,expected);
});

test('an invalid shared registry does not silently fall back to stale legacy paths',async()=>{
	for (const invalid of [null,{'Books/Old':{}},['Books/Old','books/old'],[`${configDir}/plugins`],['../Outside']]) {
		const {registry,persisted} = fixture({data:{registeredLibraries:invalid},legacy:'["Books/Legacy"]'});
		await assert.rejects(registry.read());
		await assert.rejects(registry.previewMigration());
		assert.equal(persisted.legacy,'["Books/Legacy"]');
	}
});
