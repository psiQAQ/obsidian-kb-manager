import test from 'node:test';
import assert from 'node:assert/strict';
import {declaration,verifyDeclaration} from '../src/kb/template-declaration.ts';
import {applyExclusionPlan,assertExclusionPlan,assertMoveExclusionScope,legacyTemplateRule,planMovedExclusions,planNewExclusions,templateFolderRule} from '../src/kb/template-exclusions.ts';
import {PluginDataRegistry} from '../src/registry/plugin-data.ts';

const id='10000000-0000-4000-8000-000000000001';
const plan=(rules,destination,folders)=>({...planNewExclusions(rules,destination,folders),id});

function fixture(rules){
	let data=null;
	let writes=0;
	const registry=new PluginDataRegistry('.settings',{
		load:async()=>structuredClone(data),
		save:async next=>{data=structuredClone(next);},
	});
	const store={
		readRules:async()=>[...rules],
		writeRules:async(before,after)=>{
			assert.deepEqual(rules,before);
			rules.splice(0,rules.length,...after);writes++;
		},
		readOwnership:id=>registry.readExclusionOwnership(id),
		writeOwnership:(id,before,after)=>registry.writeExclusionOwnership(id,before,after),
	};
	return {store,registry,writes:()=>writes};
}

test('suggestions name existing library-relative folders with their exact spelling',()=>{
	const folders=['模板 [草稿]+/Example (v1)','Integrations'];
	const spec=declaration(JSON.stringify({suggestedExcludedFolders:folders}));
	assert.deepEqual(spec.suggestedExcludedFolders,folders);
	assert.doesNotThrow(()=>verifyDeclaration(spec,['模板 [草稿]+/Example (v1)/note.md'],['Integrations']));
	assert.throws(()=>verifyDeclaration(spec,[],['模板 [草稿]+/Example (v1)','integrations']),/suggestedExcludedFolders/u);
	assert.throws(()=>verifyDeclaration(spec,folders,[]),/suggestedExcludedFolders/u);
	for(const input of [['../Outside'],['A','a'],['é','e\u0301'],['A/'],['/Templates'],['A\\B'],['.private'],['CON'],[true],'Templates'])
		assert.throws(()=>declaration(JSON.stringify({suggestedExcludedFolders:input})));
});

test('the generated Obsidian regexp anchors each escaped path at the vault root and a folder boundary',()=>{
	const root='Books (2025)/资料+[test].v1#',folder='模板 (草稿)/Examples+';
	const regexp=new RegExp(templateFolderRule(root,folder).slice(1,-1),'u');
	for(const value of [root+'/'+folder,root+'/'+folder+'/',root+'/'+folder+'/nested/note.md'])assert.ok(regexp.test(value),value);
	for(const value of ['archive/'+root+'/'+folder+'/note.md',root+'/'+folder+'A/note.md',
		'Books (2025)/资料+tt.v1#/'+folder+'/note.md',root+'/'+folder.replace('+','')+'/note.md','Templates/note.md'])
		assert.equal(regexp.test(value),false,value);
});

test('only selected, newly added rules are owned and unrelated concurrent changes are merged',async()=>{
	const manual=templateFolderRule('Books/A','Manual');
	const rule=templateFolderRule('Books/A','Templates');
	const rules=[manual,legacyTemplateRule];
	const {store,registry,writes}=fixture(rules);
	const approved=plan(rules,'Books/A',['Templates','Manual']);
	assert.deepEqual(approved.add,[rule]);
	assert.equal(approved.warnings.length,1);
	rules.push('some other path');
	await Promise.all([applyExclusionPlan(store,approved),registry.update(()=>['Books/A']),registry.savePreferences({language:'en',defaults:{}})]);
	await applyExclusionPlan(store,approved);
	assert.deepEqual(rules,[manual,legacyTemplateRule,'some other path',rule]);
	assert.equal(writes(),1);
	assert.deepEqual(await store.readOwnership(id),{owner:{root:'Books/A',rules:[rule]}});
	assert.deepEqual((await registry.read()).paths,['Books/A']);
	const differentVault=fixture([rule]);
	const move=await planMovedExclusions(differentVault.store,id,'Books/A','Books/B',['Templates']);
	assert.deepEqual(move.remove,[]);
	assert.deepEqual(move.add,[]);
});

test('before a confirmed update, an identical rule manually added after preview is never claimed',async()=>{
	const rules=[],{store,writes}=fixture(rules);
	const approved=plan(rules,'Books/A',['Templates']);
	rules.push(approved.add[0]);
	await assert.rejects(assertExclusionPlan(store,approved));
	await assert.rejects(applyExclusionPlan(store,approved));
	assert.equal(await store.readOwnership(id),null);
	assert.equal(writes(),0);
	const available=plan(rules,'Books/A',['Templates']);
	await applyExclusionPlan(store,available);
	assert.equal(await store.readOwnership(id),null);
	assert.equal(writes(),0);
});

test('move changes owned exact rules only and resumes after settings wrote but ownership did not finish',async()=>{
	const source='Books/A',destination='Books/B';
	const folders=['Templates','Edited','Duplicate','Manual'];
	const original=folder=>templateFolderRule(source,folder);
	const moved=folder=>templateFolderRule(destination,folder);
	const rules=[legacyTemplateRule,original('Manual')],{store,writes}=fixture(rules);
	await applyExclusionPlan(store,plan(rules,source,folders));
	const edited=original('Edited').replace('Edited','EditedManually');
	rules.splice(rules.indexOf(original('Edited')),1,edited);
	rules.push(original('Duplicate'));
	const approved=await planMovedExclusions(store,id,source,destination,folders);
	assert.deepEqual(approved.remove,[original('Templates')]);
	assert.deepEqual(approved.add,[moved('Templates')]);
	assert.equal(approved.warnings.length,4);
	assertMoveExclusionScope(approved,id,source,destination,folders);
	assert.throws(()=>assertMoveExclusionScope({...approved,remove:[legacyTemplateRule]},id,source,destination,folders));
	await assert.rejects(applyExclusionPlan({...store,writeOwnership:async(id,before,after)=>{
		if(after?.pending)return store.writeOwnership(id,before,after);
		throw new Error('interrupted');
	}},approved),/interrupted/u);
	assert.deepEqual(rules,[legacyTemplateRule,original('Manual'),edited,original('Duplicate'),original('Duplicate'),moved('Templates')]);
	await assertExclusionPlan(store,approved,true);
	await applyExclusionPlan(store,approved);
	assert.equal(writes(),2);
	assert.deepEqual(await store.readOwnership(id),{owner:{root:destination,rules:[moved('Templates')]}});
});
