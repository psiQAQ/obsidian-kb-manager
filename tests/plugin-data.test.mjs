import assert from 'node:assert/strict';
import test from 'node:test';
import { readPendingLibraryPreferences } from '../src/preferences.ts';
import { PluginDataRegistry } from '../src/registry/plugin-data.ts';

const configDir = '.settings';

function fixture({data = null} = {}) {
	const persisted = {data};
	const pluginData = {
		async load() { return structuredClone(persisted.data); },
		async save(next) { persisted.data = structuredClone(next); },
	};
	const registry = new PluginDataRegistry(configDir,pluginData);
	return {registry,persisted,pluginData};
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
	oldData.registeredLibraries = ['Books/Library'];
	const {registry,persisted} = fixture({data:oldData});
	assert.deepEqual(readPendingLibraryPreferences(undefined,oldData),{[id]:{historyDate:false}});
	assert.deepEqual((await registry.read()).paths,['Books/Library']);
	await registry.migratePreferences(oldData);
	await registry.savePreferences({language:'zh',defaults:{tree:false}});
	assert.deepEqual(persisted.data,{language:'zh',defaults:{tree:false},extension:{author:'keep this separate value'},registeredLibraries:['Books/Library']});
	assert.deepEqual((await registry.read()).paths,['Books/Library']);
});

test('a settings form changes its own defaults without reverting synced defaults, language, or registry',async()=>{
	const {registry,persisted}=fixture({data:{language:'en',defaults:{tree:false,showStatusBar:true,extension:{enabled:true}}}});
	persisted.data.language='zh';
	persisted.data.defaults.tree=true;
	persisted.data.registeredLibraries=['Books/Synced'];
	const saved=await registry.savePreferences({defaults:{showStatusBar:false,historyDate:false}});
	assert.equal(saved.language,'zh');
	assert.deepEqual(saved.defaults,{tree:true,showStatusBar:false,historyDate:false});
	await registry.savePreferences({remove:['historyDate']});
	assert.deepEqual(persisted.data,{language:'zh',defaults:{tree:true,showStatusBar:false,extension:{enabled:true}},registeredLibraries:['Books/Synced']});
	assert.deepEqual((await registry.readSettings()).paths,['Books/Synced']);
});

test('migration skips retired settings that were replaced externally after device recovery was saved',async()=>{
	const before={grants:{old:'copy'},prefs:{language:'en',defaults:{tree:false}}};
	const {registry,persisted}=fixture({data:{...before,grants:{external:'preserve'},language:'zh'}});
	assert.equal((await registry.migratePreferences(before)).language,'zh');
	assert.deepEqual(persisted.data.grants,{external:'preserve'});
	await registry.savePreferences({language:'en'});
	assert.deepEqual(persisted.data.grants,{external:'preserve'});
});

test('an invalid shared registry is rejected',async()=>{
	for (const invalid of [null,{'Books/Old':{}},['Books/Old','books/old'],[`${configDir}/plugins`],['../Outside']]) {
		const {registry} = fixture({data:{registeredLibraries:invalid}});
		await assert.rejects(registry.read());
	}
});
