import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {stringify as toml} from 'smol-toml';
import {parse as yaml, stringify as yamlString} from 'yaml';
import {commonCheckTrusted,runDiagnostics} from '../src/diagnostics/index.ts';
import {checkKitFiles,checkKitVersion} from '../src/kb/check-kit.ts';
import {writeCheckKit} from '../src/kb/identity-core.ts';

const digest = text => createHash('sha256').update(text).digest('hex');
const location = 'Category/课程';
const rootToken = '__ROOT__';
const base = 'Views/Courses.base';
const readme = '# Course\n\n## Overview\n\n![['+rootToken+'/'+base+']]\n\n## Other notes\n';
const filters = 'filters:\n  and:\n    - "file.path.startsWith(\\"'+rootToken+'/\\")"\n'
	+ '    - "this.file.path.startsWith(\\"'+rootToken+'/\\")"\nviews:\n  - name: Courses\n    type: table\n';
const assignment = '---\ncourse: "[['+rootToken+'/Notes/Course]]"\n---\n# Assignment\n';

function bind(path,source) {
	let offset = 0;
	const parts = source.split(rootToken);
	const offsets = parts.slice(0,-1).map(part => offset += part.length);
	const rendered = parts.join(location);
	return {rendered,managed:{path,role:'template-root',root:location,offsets,fingerprint:digest(rendered)}};
}

async function fixture(t, withHistory = true) {
	const workspace = resolve('.tmp');
	await fs.mkdir(workspace,{recursive:true});
	const vault = await fs.mkdtemp(join(workspace,'binding-diagnostics-'));
	t.after(async () => {
		assert.equal(dirname(vault),workspace);
		await fs.rm(vault,{recursive:true,force:true});
	});
	const root = join(vault,location);
	const put = async (path,text) => {
		const file = join(root,path);
		await fs.mkdir(dirname(file),{recursive:true});
		await fs.writeFile(file,text);
	};
	const git = (...args) => execFileSync('git',args,{cwd:root,windowsHide:true,stdio:'pipe'});
	const markdown = bind('README.md',readme);
	const courses = bind(base,filters);
	const properties = bind('Assignments/Today.md',assignment);
	// A creation kit can track normalized Git blobs while recording the CRLF worktree fingerprint.
	const withCrLf = text => text.replaceAll('\n','\r\n');
	const crlf = bind('Notes/Root.md',withCrLf('# Root\n\n![['+rootToken+'/'+base+']]\n'));
	for (const item of [markdown,courses,properties]) await put(item.managed.path,item.rendered);
	await put(crlf.managed.path,crlf.rendered.replaceAll('\r\n','\n'));
	await put('Notes/Course.md','# Course\n');
	await put('Other/Course.md','# Another course with the same filename\n');
	const kit = checkKitFiles();
	for (const [name,source] of Object.entries(kit)) await put(name,source);
	const raw = toml({version:2,manager:{schemaVersion:2,id:'81079855-d3ba-4c76-b59a-042412ba624a',
		displayName:'Course',description:'',archived:false,template:{id:'course-test',version:'1'},
		managed:[markdown,courses,properties,crlf].map(item => item.managed)}});
	await put('kb.toml',writeCheckKit(raw,{protocol:1,version:checkKitVersion,digests:Object.fromEntries(
		Object.entries(kit).map(([path,source]) => [path,digest(source)]))}));
	if (withHistory) {
		git('init');
		git('add','--','.');
		git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','Initial fixture');
	}
	const check = async options => (await runDiagnostics({libraryRoot:root,vaultRoot:vault,selected:['bindings'],...options})).checks[0];
	return {base:courses.rendered,readme:markdown.rendered,assignment:properties.rendered,put,check,remove:path => fs.unlink(join(root,path))};
}

test('managed binding diagnostics use file structure and actual targets after ordinary edits', async t => {
	const item = await fixture(t);
	const serialized = yamlString(yaml(item.base),{defaultStringType:'QUOTE_SINGLE'});
	assert.notEqual(serialized,item.base);
	await item.put(base,serialized);
	await item.put('README.md',item.readme.replace(location+'/'+base,'./'+base)+'\nAdditional notes.\n');
	await item.put('Assignments/Today.md',item.assignment.replace(location+'/Notes/Course','../Notes/Course'));
	const harmless = await item.check();
	assert.equal(harmless.status,'passed');
	assert.deepEqual(harmless.coverage,{checked:4,skipped:0,unknown:0});
	assert.deepEqual(harmless.diagnostics,[]);

	await item.put('README.md',item.readme.replace(location+'/'+base,'./Views/Wrong.base')+'\n![['+location+'/'+base+']]\n');
	await item.put(base,serialized.replace(location+'/', 'Another/Root/')+'\n# Original text: '+location+'/\n');
	await item.put('Assignments/Today.md',item.assignment.replace(location+'/Notes/Course','../Other/Course')+'\n[['+location+'/Notes/Course]]');
	const changed = await item.check();
	assert.equal(changed.status,'findings');
	assert.deepEqual(changed.diagnostics.filter(row => row.code === 'binding-drift').map(row => row.file),
		['README.md',base,'Assignments/Today.md']);
	assert.match(changed.diagnostics.find(row => row.file === base).evidence,/filters\.and\[0\].*Another\/Root/u);
});

test('unchanged source links still require a readable target and desktop link resolution', async t => {
	const item = await fixture(t);
	const notIndexed = await item.check({resolveLink:() => ({status:'unknown'})});
	assert.equal(notIndexed.status,'partial');
	assert.ok(notIndexed.diagnostics.some(row => row.file === 'Assignments/Today.md' && row.code === 'binding-unverified'));
	await item.remove('Notes/Course.md');
	const missing = await item.check();
	assert.equal(missing.status,'findings');
	assert.ok(missing.diagnostics.some(row => row.file === 'Assignments/Today.md' && row.code === 'binding-drift'));
});

test('binding checks report unavailable evidence and identify known legacy bundled scripts', async t => {
	const item = await fixture(t,false);
	await item.put('README.md',item.readme+'\nChanged, with no history available.\n');
	const unknown = await item.check();
	assert.equal(unknown.status,'partial');
	assert.ok(unknown.diagnostics.some(row => row.file === 'README.md' && row.code === 'binding-unverified'));
	assert.ok(!unknown.diagnostics.some(row => row.code === 'binding-drift'));
	const path = 'checks/common/bindings.mjs';
	const legacyDigest = '6790d389efcf4140efe309cfa4a36ffffbe56dc210886ce44019b012c796bd49';
	assert.equal(commonCheckTrusted({path,digest:legacyDigest}),true);
	assert.equal(commonCheckTrusted({path,digest:digest('custom source')}),false);
});
