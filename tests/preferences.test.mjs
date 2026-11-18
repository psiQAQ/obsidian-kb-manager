import test from 'node:test';
import assert from 'node:assert/strict';
import {effectivePreferences, readPreferences} from '../src/preferences.ts';

const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const identity = {author:'Previous author', email:'legacy@example.invalid'};

test('old settings retain the author and leave automation off', () => {
	const store = readPreferences(undefined);
	const settings = effectivePreferences(store,identity,a);
	assert.equal(store.language,'system');
	assert.equal(settings.author,identity.author);
	assert.equal(settings.email,identity.email);
	assert.equal(settings.backend,'builtin');
	assert.equal(settings.autoPullMinutes + settings.autoPushMinutes + settings.autoCommitMinutes,0);
});

test('ID-bound overrides survive reload and inherit individual fields', () => {
	const store = readPreferences({
		language:'en', defaults:{tree:true,author:'Global',backend:'native'},
		libraries:{[a]:{author:'',tree:false},[b]:{backend:'builtin'}},
	});
	const loaded = readPreferences(JSON.parse(JSON.stringify(store)));
	assert.equal(loaded.language,'en');
	assert.equal(effectivePreferences(loaded,identity,a).author,'');
	assert.equal(effectivePreferences(loaded,identity,a).tree,false);
	assert.equal(effectivePreferences(loaded,identity,b).author,'Global');
	assert.equal(effectivePreferences(loaded,identity,b).tree,true);
	delete loaded.libraries[a].tree;
	assert.equal(effectivePreferences(loaded,identity,a).tree,true);
	assert.equal(effectivePreferences(loaded,identity,a).backend,'native');
	assert.equal(effectivePreferences(loaded,identity,b).backend,'builtin');
});

test('invalid values and repository paths cannot become saved preferences', () => {
	const store = readPreferences({
		language:'bad',defaults:{autoPullMinutes:-1,autoCommitMinutes:0.5,autoPushMinutes:Infinity,backend:'shell',author:12},
		libraries:{[a]:{autoCommitMinutes:5,token:'secret',tree:'yes'},'libraries/A':{backend:'native'}},
	});
	assert.deepEqual(store,{language:'system',defaults:{},libraries:{[a]:{autoCommitMinutes:5}}});
});
