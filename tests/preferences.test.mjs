import test from 'node:test';
import assert from 'node:assert/strict';
import {effectivePreferences, gitDefaults, readPreferences} from '../src/preferences.ts';

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

test('every supported default can round trip as a library override', () => {
	const saved = readPreferences({language:'zh',libraries:{[a]:gitDefaults}});
	assert.deepEqual(saved.libraries[a],gitDefaults);
	assert.deepEqual(effectivePreferences(saved,identity,a),gitDefaults);
});

test('legacy display toggles retain their meaning alongside per-library display modes', () => {
	const store=readPreferences({defaults:{historyAuthor:false,hunkStatusBar:true},libraries:{[a]:{historyAuthor:'initials',hunkStatusBar:'colored'}}});
	assert.equal(effectivePreferences(store,identity,b).historyAuthor,'hidden');
	assert.equal(effectivePreferences(store,identity,b).hunkStatusBar,'plain');
	assert.equal(effectivePreferences(store,identity,a).historyAuthor,'initials');
	assert.equal(effectivePreferences(store,identity,a).hunkStatusBar,'colored');
});

test('unsafe colors and invalid time budgets fall back without starting a timer', () => {
	const saved = readPreferences({defaults:{blameText:'url(example)',blameNew:'#bad',diffTimeout:-1,
		refreshSourceControlTimer:2147483648,autoAfterEdits:10}, libraries:{[b]:{blameTimezone:'author'}}});
	assert.deepEqual(saved.defaults,{});
	assert.equal(effectivePreferences(saved,identity,b).blameTimezone,'author');
});
