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
	await registry.savePreferences({language:'zh',defaults:{tree:false}});
	assert.deepEqual(persisted.data,{language:'zh',defaults:{tree:false},extension:{author:'keep this separate value'},registeredLibraries:['Books/Library']});
	assert.deepEqual((await registry.read()).paths,['Books/Library']);
});

test('an invalid shared registry is rejected',async()=>{
	for (const invalid of [null,{'Books/Old':{}},['Books/Old','books/old'],[`${configDir}/plugins`],['../Outside']]) {
		const {registry} = fixture({data:{registeredLibraries:invalid}});
		await assert.rejects(registry.read());
	}
});
