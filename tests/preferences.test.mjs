import test from 'node:test';
import {migrateGitSettings} from '../src/git/settings-migration.ts';
import assert from 'node:assert/strict';
import {clearLegacyAuthors, effectivePreferences, gitDefaults, readPendingLibraryPreferences, readPreferences} from '../src/preferences.ts';
import {previewPreferenceMigration} from '../src/kb/preference-migration.ts';
import {readManifest, writeIdentity, writePreferences} from '../src/kb/identity-core.ts';

const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const identity = {author:'Previous author', email:'legacy@example.invalid'};

test('defaults omit author fields and leave automation off', () => {
	const store = readPreferences(undefined);
	const settings = effectivePreferences(store,a);
	assert.equal(store.language,'system');
	assert.equal(settings.author,undefined);
	assert.equal(settings.email,undefined);
	assert.equal(settings.backend,undefined);
	assert.equal(settings.autoPullMinutes + settings.autoPushMinutes + settings.autoCommitMinutes,0);
});

test('ID-bound overrides survive reload and inherit individual fields', () => {
	const store = readPreferences({
		language:'en', defaults:{tree:true,author:'Global',backend:'native'},
		libraries:{[a]:{author:'',tree:false},[b]:{backend:'builtin'}},
	});
	const loaded = readPreferences(JSON.parse(JSON.stringify(store)));
	assert.equal(loaded.language,'en');
	assert.equal(effectivePreferences(loaded,a).author,undefined);
	assert.equal(effectivePreferences(loaded,a).tree,false);
	assert.equal(effectivePreferences(loaded,b).author,undefined);
	assert.equal(effectivePreferences(loaded,b).tree,true);
	delete loaded.libraries[a].tree;
	assert.equal(effectivePreferences(loaded,a).tree,true);
	assert.equal(effectivePreferences(loaded,a).backend,undefined);
	assert.equal(effectivePreferences(loaded,b).backend,undefined);
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
	assert.deepEqual(effectivePreferences(saved,a),gitDefaults);
});

test('legacy display toggles retain their meaning alongside per-library display modes', () => {
	const store=readPreferences({defaults:{historyAuthor:false,hunkStatusBar:true},libraries:{[a]:{historyAuthor:'initials',hunkStatusBar:'colored'}}});
	assert.equal(effectivePreferences(store,b).historyAuthor,'hidden');
	assert.equal(effectivePreferences(store,b).hunkStatusBar,'plain');
	assert.equal(effectivePreferences(store,a).historyAuthor,'initials');
	assert.equal(effectivePreferences(store,a).hunkStatusBar,'colored');
});

test('unsafe colors and invalid time budgets fall back without starting a timer', () => {
	const saved = readPreferences({defaults:{blameText:'url(example)',blameNew:'#bad',diffTimeout:-1,
		refreshSourceControlTimer:2147483648,autoAfterEdits:10}, libraries:{[b]:{blameTimezone:'author'}}});
	assert.deepEqual(saved.defaults,{});
	assert.equal(effectivePreferences(saved,b).blameTimezone,'author');
});

test('cleanup removes all three legacy identity scopes without changing unrelated data',()=>{
	const saved={...identity,known:{[a]:'Library A'},prefs:{defaults:{...identity,tree:false},libraries:{[a]:{...identity,historyDate:true},[b]:{tree:true}}},extra:{author:'retain'}};
	assert.equal(clearLegacyAuthors(saved),true);
	assert.deepEqual(saved,{known:{[a]:'Library A'},prefs:{defaults:{tree:false},libraries:{[a]:{historyDate:true},[b]:{tree:true}}},extra:{author:'retain'}});
	assert.equal(clearLegacyAuthors(saved),false);
});

test('upgrading either platform removes stored targets and backend choices before automation starts',()=>{
	const old={location:'kb/A',branch:'main',remote:'origin',remoteBranch:'main',url:'https://private.example.invalid/owner/library',
		backend:'builtin',commit:1,pull:5,push:0,paused:'authentication failed for PRIVATE',
		autoGlobs:'',autoGlobMode:'exclude',autoAfterEdits:false,autoFromLastCommit:false,autoPullOnStart:false};
	const saved={prefs:{defaults:{backend:'builtin',tree:true},libraries:{[a]:{backend:'native',diffTimeout:20}}},
		grants:{[a]:old},known:{[a]:'kb/A'},custom:'preserve'};
	assert.equal(migrateGitSettings(saved),true);
	assert.equal(saved.grants[a].paused,'review');
	assert.equal(saved.custom,'preserve');
	assert.deepEqual(saved.prefs,{defaults:{tree:true},libraries:{[a]:{diffTimeout:20}}});
	assert.deepEqual(saved.known,{[a]:'kb/A'});
	assert.doesNotMatch(JSON.stringify(saved),/private\.example|PRIVATE|backend/);
	assert.equal(migrateGitSettings(saved),false);
});

test('older per-ID overrides persist locally before old shared preferences are removed',()=>{
	const upper='ABCDEF00-0000-4000-8000-000000000001';
	const id=upper.toLowerCase();
	const legacy={prefs:{language:'zh',libraries:{[upper]:{tree:true,autoPullMinutes:8,token:'discard',...identity},
		[b]:{invalid:'discard'}}},grants:{[upper]:{pull:8}}};
	const pending=readPendingLibraryPreferences({[id]:{tree:false,commitMessage:'Local',grant:{pull:1}}},legacy);
	assert.deepEqual(pending,{[id]:{tree:false,autoPullMinutes:8,commitMessage:'Local'}});
	const local=JSON.parse(JSON.stringify(pending));
	assert.equal(JSON.stringify(readPendingLibraryPreferences(local,{language:'zh'})),JSON.stringify(pending));
	assert.equal(effectivePreferences(readPreferences({language:'zh'}),id).autoPullMinutes,0);
});

test('migration preview requires the exact unique writable ID and merges only confirmed fields',()=>{
	const identity={schemaVersion:1,id:a,displayName:'Library',description:'',archived:false,template:{id:'folder',version:'1'},managed:[]};
	const target={identity,location:'Books/Papers',git:'local',signature:'observed',preferences:{tree:false,diffStyle:'split'}};
	const previous={tree:true,showStatusBar:false};
	assert.throws(()=>previewPreferenceMigration([{...target,identity:{...identity,id:b}}],a,previous),/same ID|同 ID/u);
	assert.throws(()=>previewPreferenceMigration([target,{...target,location:'Other/Papers'}],a,previous),/unique|唯一/u);
	assert.throws(()=>previewPreferenceMigration([{...target,identity:{...identity,archived:true}}],a,previous),/writable|可写/u);
	assert.throws(()=>previewPreferenceMigration([target],a,undefined),/changed|变化/u);
	const preview=previewPreferenceMigration([target],a,previous);
	const initial=writePreferences(writeIdentity('',identity),target.preferences);
	const updated=writePreferences(initial,preview.overrides);
	assert.deepEqual(readManifest(updated).preferences,{tree:true,showStatusBar:false,diffStyle:'split'});
	assert.equal(readManifest(updated).identity.id,a);
	assert.equal(preview.target.location,'Books/Papers');
	assert.deepEqual(preview.previous,previous);
});
