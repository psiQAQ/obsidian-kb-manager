import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {templateCatalog} from '../scripts/template-catalog.mjs';
import {declaration, folderTemplate, checkCreationRequirements} from '../src/kb/template.ts';
import {templateCompatibility} from '../src/kb/template-requirements.ts';

test('legacy descriptors and all bundled packs remain valid; new declarations give precise compatibility errors', () => {
	const root=fileURLToPath(new URL('../assets/templates/',import.meta.url));
	assert.equal(Object.keys(templateCatalog(root).packs).length,18);
	const legacy={id:'example',version:'v1.2 (draft)',dependencies:['old-workflow']};
	assert.deepEqual(declaration(JSON.stringify(legacy)),legacy);
	for(const [data,reason] of [
		[{protocolVersion:2},/2/u],
		[{minManagerVersion:'3.4'},/minManagerVersion/u],
		[{dependencies:['x',{id:'x',required:false}]},/dependencies/u],
		[{dependencies:[{id:'x',required:'yes'}]},/dependencies/u],
		[{id:'test',version:'1',managedFiles:['checks/common/manifest.mjs']},/managedFiles/u],
		[{id:'test',version:'1',managedFiles:['kb.toml']},/managedFiles/u],
		[{managedFiles:['Templates/New.md']},/id and version/u],
	])assert.throws(()=>declaration(JSON.stringify(data)),reason);
});

test('the installed manager and enabled plugin versions meet or block the declared minimum', () => {
	const spec={minManagerVersion:'3.10.0',dependencies:[
		{id:'needed',required:true,minVersion:'2.11.1'},'optional',
	]};
	const host={version:'3.9.9',pluginVersion:()=>undefined};
	assert.equal(templateCompatibility(spec,host).blockers.length,2);
	assert.equal(templateCompatibility(spec,host).optional.length,1);
	host.version='3.10.0';
	host.pluginVersion=id=>id==='needed'?'2.11.1-beta.2':undefined;
	assert.equal(templateCompatibility(spec,host).blockers.length,1);
	host.pluginVersion=id=>id==='needed'?'2.11.1+build.2':undefined;
	assert.deepEqual(templateCompatibility(spec,host).blockers,[]);
});

test('the documented example renders independent links and leaves its optional workflow available to enable later', async () => {
	const root=fileURLToPath(new URL('../docs/examples/protocol-template/',import.meta.url));
	for(const destination of ['书架/甲','书架/乙']){
		const sample=await folderTemplate(root,'.test-settings',{displayName:destination.split('/')[1],description:'',destination});
		const home=sample.files.find(file=>file.name==='首页.md');
		assert.ok(new TextDecoder().decode(home.bytes).includes('[['+destination+'/Templates/读书卡|'));
		assert.equal(checkCreationRequirements(sample,{version:'3.4.0',pluginVersion:()=>undefined}).length,1);
	}
});
