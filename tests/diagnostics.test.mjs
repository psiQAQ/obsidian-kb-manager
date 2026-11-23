import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fsPromises, * as fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {build} from 'esbuild';
import {compareDiagnosticReports, diagnosticFreshness, listDiagnosticHistory, listSpecialChecks, runDiagnostics} from '../src/diagnostics/index.ts';
import {saveDiagnosticReport} from '../src/diagnostics/history.ts';
import {setLanguage} from '../src/i18n.ts';
import {checkKitFiles,checkKitVersion} from '../src/kb/check-kit.ts';
import {writeCheckKit} from '../src/kb/identity-core.ts';

const id = '81079855-d3ba-4c76-b59a-042412ba624a';
const relative = 'libraries/示例库';
const manifest = `version = 2
[paths]
notes = "notes"
[variables]
threshold = 7
[preferences]
disablePush = true
privateToken = "not-shared"
[manager]
schemaVersion = 2
id = "${id}"
displayName = "示例库"
description = ""
archived = false
entry = "name.md"
[manager.template]
id="fixture"
version="2"
`;
const declaration = {
	id:'fixture', version:'2', entry:'name.md', pageTemplates:['templates'], variables:{threshold:5},
	checks:[{id:'fixture.check', name:'专项', path:'checks/checker.mjs', description:'验证上下文。'}],
};
const digest = code => createHash('sha256').update(code).digest('hex');
const result = (report, id) => report.checks.find(check => check.id === id);
const codes = check => check.diagnostics.map(row => row.code);

async function fixture(t) {
	const workspace = path.resolve('.tmp');
	await fs.mkdir(workspace, {recursive:true});
	const vault = await fs.mkdtemp(path.join(workspace, 'diagnostics-'));
	t.after(async () => {
		assert.equal(path.dirname(path.resolve(vault)),workspace);
		await fs.rm(vault, {recursive:true, force:true});
	});
	const root = path.join(vault, relative);
	await fs.mkdir(path.join(vault,'.settings'));
	const put = async (file, value) => {
		const filename = path.join(root,file);
		await fs.mkdir(path.dirname(filename),{recursive:true});
		await fs.writeFile(filename,value);
	};
	await put('kb.toml',manifest);
	await put('kb-template.json',JSON.stringify(declaration));
	await put('name.md','# 入口\n');
	await put('notes/target.md','---\nstatus: ready\n---\n# Local heading\n\nA block. ^visible\n');
	await put('templates/sample.md','Template sample.\n');
	return {vault,root,put, options:{libraryRoot:root,vaultRoot:vault,configDir:'.settings',registered:true,duplicate:false,nodeExecutable:process.execPath}};
}

async function withUnscannableDirectory(t, denied, run) {
	const readdir = fs.readdir;
	const mocked = t.mock.method(fsPromises,'readdir',async (target,...args) => {
		if (target === denied) throw Object.assign(new Error('Access denied'),{code:'EACCES'});
		return await readdir(target,...args);
	});
	syncBuiltinESMExports();
	try {return await run();}
	finally {mocked.mock.restore(); syncBuiltinESMExports();}
}

test('a library executes reviewed common and template sources and reports failures independently', async t => {
	const {options,put,root} = await fixture(t);
	const kit = checkKitFiles();
	const hashes = {};
	for (const [name,source] of Object.entries(kit)) {
		await put(name,source);
		hashes[name] = digest(source);
	}
	const entry = 'checks/common/properties.mjs';
	await put('fixture.base','views:\n  - type: table\n    name: Example\n');
	const common = 'export default ({result},{recordChecked}) => {recordChecked(result,"name.md","Custom rule","Found a problem",1); result.diagnostics.push({code:"edited-common",severity:"warning",file:"name.md",line:1,message:"Common finding"}); return result;}';
	const special = 'export default () => [{code:"edited-special",severity:"warning",file:"name.md",line:1,message:"Template finding"}];';
	await put('kb.toml',writeCheckKit(manifest,{protocol:1,version:checkKitVersion,digests:hashes}));
	await put(entry,common);
	await put('checks/checker.mjs',special);
	const selected = ['properties','fixture.check','bases'];
	const run = trustedDigests => runDiagnostics({...options,selected,trustedDigests});
	const approved = [digest(common),digest(special)];
	const before = await run([]);
	assert.deepEqual(before.checks.slice(0,2).map(codes),[['checker-untrusted'],['checker-untrusted']]);
	const after = await run(approved);
	assert.deepEqual(result(after,'properties').checkedItems,[{file:'name.md',subject:'Custom rule',outcome:'Found a problem',line:1}]);
	assert.deepEqual(after.checks.slice(0,2).flatMap(c=>c.diagnostics.map(d=>[d.code,d.file,d.line])),[
		['edited-common','name.md',1],['edited-special','name.md',1],
	]);
	const broken = 'export default () => {throw new Error("fixture");};';
	await put(entry,broken);
	assert.deepEqual(codes(result(await run(approved),'properties')),['checker-untrusted']);
	assert.deepEqual(codes(result(await run([...approved,digest(broken)]),'properties')),['checker-execution']);
	await fs.unlink(path.join(root,entry));
	const missing = await run(approved);
	assert.equal(missing.status,'failed');
	assert.deepEqual(codes(result(missing,'properties')),['checker-unavailable']);
	assert.equal(result(missing,'properties').diagnostics[0].file,entry);
	assert.equal(result(missing,'bases').status,'passed');
});

test('checked rows account for files and positive and negative results in new and legacy libraries', async t => {
	const {options,put,root} = await fixture(t);
	const selected = ['manifest','properties','links','anchors','bases','canvas','portability'];
	await put('name.md','# Entry\n\n[[./notes/target.md#Local heading]]\n![[./missing.png]]\n');
	await put('Example.base','views:\n  - name: Notes\n    type: table\n');
	await put('Bad.canvas','{"nodes":[],"edges":[{"id":"x","fromNode":"missing","toNode":"missing"}]}');
	for (const kit of [false,true]) {
		if (kit) for (const [file,text] of Object.entries(checkKitFiles())) await put(file,text);
		const report=await runDiagnostics({...options,selected});
		for (const check of report.checks) {
			assert.ok(check.coverage.checked>0,check.id);
			assert.equal(check.checkedItems.reduce((n,row)=>n+(row.count??1),0),check.coverage.checked,check.id);
			assert.ok(check.checkedItems.every(row=>row.file && row.subject && row.outcome),check.id);
		}
		assert.ok(result(report,'links').checkedItems.some(row=>row.file==='name.md' && row.subject.includes('missing.png')));
		assert.ok(result(report,'anchors').checkedItems.some(row=>row.subject.includes('Local heading')));
		assert.ok(result(report,'canvas').diagnostics.some(row=>row.code==='canvas-dangling-edge'));
		assert.ok(result(report,'canvas').checkedItems.some(row=>row.file==='Bad.canvas'));
		const saved=(await listDiagnosticHistory(root)).find(row=>row.runId===report.runId);
		assert.deepEqual(saved.checks.map(c=>c.checkedItems),report.checks.map(c=>c.checkedItems));
	}
});

test('template exclusions filter each source check while preserving resolved targets and other checks', async t => {
	for (const kit of [false,true]) await t.test(kit ? 'distributed rules and CLI' : 'legacy rules', async t => {
		const {options,put,root,vault} = await fixture(t);
		const diagnosticExclusions = [
			{checks:['links','anchors','portability','bases'],folders:['Guide']},
			{checks:['links','bases'],files:['Guide/sample.md','Standalone.base']},
			{checks:['links'],files:['Links only.md']},
		];
		await put('kb-template.json',JSON.stringify({...declaration,diagnosticExclusions}));
		await put('name.md','[[./Guide/sample.md#Guide heading]]\n![[./Standalone.base#Example]]\n');
		await put('Guide/sample.md','---\nrepeated: 1\nrepeated: 2\n---\n# Guide heading\n[[./missing.md]]\n```base\nviews: invalid\n```\n');
		await put('Guide/plain.md','<!--\n```base\nviews: invalid\n```\n-->\n');
		await put('Guide/nested/target.md','# Second candidate\n');
		await put('Guide/Bad.canvas','{');
		await put('Guide/attachment.txt','A non-source file\n');
		await put('Guide-other/keep.md','[[./ordinary-missing.md]]\n');
		await put('Standalone.base','views:\n  - type: table\n    name: Example\n    filters: 5\n');
		await put('Regular.base','views: invalid\n');
		await put('Links only.md','[[./notes/target.md#^missing]]\n');
		if (kit) for (const [file,text] of Object.entries(checkKitFiles())) await put(file,text);
		const selected = ['links','anchors','portability','bases','properties','canvas'];
		const report = await runDiagnostics({...options,selected});
		const excluded = id => result(report,id).templateExcludedSources;
		assert.deepEqual(excluded('links'),[
			{file:'Guide/nested/target.md',matches:['folders:Guide']},
			{file:'Guide/plain.md',matches:['folders:Guide']},
			{file:'Guide/sample.md',matches:['files:Guide/sample.md','folders:Guide']},
			{file:'Links only.md',matches:['files:Links only.md']},
		]);
		assert.equal(result(report,'links').coverage.skipped, excluded('links').length + Number(kit));
		assert.deepEqual(result(report,'links').diagnostics.map(row => row.file),['Guide-other/keep.md']);
		assert.ok(result(report,'anchors').checkedItems.some(row => row.file === 'name.md' && row.subject.includes('Guide heading')));
		assert.ok(result(report,'anchors').checkedItems.some(row => row.file === 'name.md' && row.subject.includes('Example')));
		assert.deepEqual(result(report,'anchors').diagnostics.map(row => [row.file,row.code]),[['Links only.md','missing-anchor']]);
		assert.ok(excluded('portability').some(row => row.file === 'Guide/Bad.canvas'));
		assert.ok(!result(report,'portability').diagnostics.some(row => row.file === 'Guide/Bad.canvas'));
		assert.deepEqual(excluded('bases'),[
			{file:'Guide/sample.md',matches:['files:Guide/sample.md','folders:Guide']},
			{file:'Standalone.base',matches:['files:Standalone.base']},
		]);
		assert.deepEqual(result(report,'bases').diagnostics.map(row => row.file),['Regular.base']);
		assert.ok(result(report,'properties').diagnostics.some(row => row.file === 'Guide/sample.md'));
		assert.ok(result(report,'canvas').diagnostics.some(row => row.file === 'Guide/Bad.canvas'));
		assert.equal(excluded('properties'),undefined);
		assert.equal(excluded('canvas'),undefined);

		await put('name.md','[[target]]\n');
		const visited = [];
		const desktop = await runDiagnostics({...options,selected:['portability'],
			collectLinks:source => {
				visited.push(source);
				return source === `${relative}/name.md` ? [{target:'target',kind:'link'}] : [];
			},
			resolveLink:() => ({status:'resolved',path:`${relative}/notes/target.md`})});
		assert.ok(!visited.some(source => source.includes('/Guide/')));
		const candidates = result(desktop,'portability').diagnostics.find(row => row.code === 'same-name-candidates');
		assert.ok(candidates.evidence.includes(`${relative}/Guide/nested/target.md`));

		if (kit) {
			const argv = [path.join(root,'checks','kb-check.cjs'),'--library',root,'--vault-root',vault,'--checks','links'];
			let output;
			try {output = execFileSync(process.execPath,argv,{encoding:'utf8'});}
			catch (error) {assert.equal(error.status,1); output = error.stdout;}
			const cliLinks = result(JSON.parse(output),'links');
			assert.deepEqual(cliLinks.templateExcludedSources,excluded('links'));
			assert.equal(cliLinks.rule.engine,'bundled');
		}
	});
});

test('all excluded sources skip while unavailable targets, Markdown with unverified Base content, and directories remain unknown', async t => {
	const {options,put,root} = await fixture(t);
	const diagnosticExclusions = [
		{checks:['links','anchors','portability'],files:['name.md'],folders:['notes','templates']},
		{checks:['bases'],folders:['notes'],files:['View.base']},
	];
	await put('kb-template.json',JSON.stringify({...declaration,diagnosticExclusions}));
	await put('name.md','[[./missing.md]]\n');
	await put('notes/unreadable.md',Buffer.from([0xff]));
	await put('View.base','views: invalid\n');
	const selected = ['links','anchors','portability','bases'];
	const full = await runDiagnostics({...options,selected,linkCandidateScope:'registered'});
	for (const id of ['links','anchors','portability']) {
		const check = result(full,id);
		assert.equal(check.status,'skipped');
		assert.deepEqual(check.coverage,{checked:0,unknown:0,skipped:4});
		assert.deepEqual(check.diagnostics,[]);
	}
	assert.equal(result(full,'bases').status,'partial');
	assert.deepEqual(codes(result(full,'bases')),['unreadable-note']);
	assert.deepEqual(result(full,'bases').templateExcludedSources,[{file:'View.base',matches:['files:View.base']}]);
	await put('Reference.md','[[./notes/target.md#Local heading]]\n[[./notes/unreadable.md#Heading]]\n');
	const anchors = result(await runDiagnostics({...options,selected:['anchors']}),'anchors');
	assert.equal(anchors.coverage.checked,1, 'an excluded Markdown source is loaded as an anchor target when needed');
	assert.equal(anchors.coverage.unknown,1);
	assert.deepEqual(codes(anchors),['unverified-anchor']);
	await put('notes/hidden/target.md','# Inside an unreadable directory\n');
	const inaccessible = await withUnscannableDirectory(t,path.join(root,'notes','hidden'),() => runDiagnostics({...options,selected:['links']}));
	assert.ok(codes(result(inaccessible,'links')).includes('unreadable-directory'));
});

test('approved edited rules receive filtered sources and invalid exclusions identify the declaration field', async t => {
	const {options,put} = await fixture(t);
	for (const [file,text] of Object.entries(checkKitFiles())) await put(file,text);
	const edited = `export default ({result,notes},{recordChecked}) => {
		for (const {file} of notes) recordChecked(result,file,"Edited rule","Source supplied");
		return result;
	};`;
	await put('checks/common/links.mjs',edited);
	const diagnosticExclusions = [{checks:['links'],folders:['notes','templates']}];
	await put('kb-template.json',JSON.stringify({...declaration,diagnosticExclusions}));
	const trusted = {...options,trustedDigests:[digest(edited)]};
	const report = result(await runDiagnostics({...trusted,selected:['links']}),'links');
	assert.equal(report.rule.engine,'node');
	assert.deepEqual(report.checkedItems.map(item => item.file),['name.md']);
	assert.equal(report.templateExcludedSources.length,2);
	await put('kb-template.json',JSON.stringify({...declaration,diagnosticExclusions:[{...diagnosticExclusions[0],files:['name.md']}]}));
	const skipped = result(await runDiagnostics({...trusted,selected:['links']}),'links');
	assert.equal(skipped.status,'skipped');
	assert.equal(skipped.templateExcludedSources.length,3);
	await put('kb-template.json',JSON.stringify({...declaration,diagnosticExclusions:[{checks:['links'],files:['../bad.md']}]}));
	const invalid = await runDiagnostics({...trusted,selected:['links','manifest','properties']});
	assert.equal(result(invalid,'links').status,'partial');
	assert.match(result(invalid,'links').reason,/diagnosticExclusions\.0\.files\.0/u);
	assert.match(result(invalid,'manifest').diagnostics.find(row => row.code === 'invalid-template').message,/diagnosticExclusions\.0\.files\.0/u);
	assert.equal(result(invalid,'properties').status,'passed');
});

test('only common rules with matching official paths and digests run without a local Node executable', async t => {
	const {options,root,put} = await fixture(t);
	const {['checks/common/manifest.mjs']:officialManifest,['checks/common/properties.mjs']:officialProperties} = checkKitFiles();
	const manifestPath = 'checks/common/manifest.mjs', propertiesPath = 'checks/common/properties.mjs';
	await put('kb.toml',writeCheckKit(manifest,{protocol:1,version:checkKitVersion,digests:{
		[manifestPath]:digest(officialManifest),[propertiesPath]:digest(officialProperties),
	}}));
	await put(manifestPath,officialManifest);
	await put(propertiesPath,officialManifest);
	const special = 'export default () => [];';
	await put('checks/checker.mjs',special);
	const attempt = await runDiagnostics({...options,selected:['manifest','properties','fixture.check'],
		nodeExecutable:path.join(root,'missing-node.exe'),officialDigests:[digest(special)]});
	assert.equal(result(attempt,'manifest').status,'passed');
	assert.deepEqual(result(attempt,'manifest').rule,{
		engine:'bundled',version:checkKitVersion,path:manifestPath,digest:digest(officialManifest),
	});
	assert.deepEqual(codes(result(attempt,'properties')),['checker-untrusted']);
	assert.deepEqual(codes(result(attempt,'fixture.check')),['checker-node']);
	assert.equal(result(attempt,'fixture.check').rule.engine,'node');
	const authorized = await runDiagnostics({...options,selected:['properties'],trustedDigests:[digest(officialManifest)],
		nodeExecutable:path.join(root,'missing-node.exe')});
	assert.deepEqual(codes(result(authorized,'properties')),['checker-node']);
	assert.equal(result(authorized,'properties').rule.engine,'node');
	await put(propertiesPath,officialProperties);
	assert.equal(await diagnosticFreshness(options,attempt),'stale');
	const bundled = await runDiagnostics({...options,selected:['properties'],nodeExecutable:path.join(root,'missing-node.exe')});
	assert.equal(result(bundled,'properties').status,'passed');
	assert.equal(result(bundled,'properties').rule.engine,'bundled');
});

test('desktop native link evidence and partial coverage distinguish unresolved files and intended cross-library links', async t => {
	const {options,put} = await fixture(t);
	await put('name.md','Title\n');
	await put('notes/bad.md','---\nproperty: 1\nproperty: 2\n---\n');
	const occurrences = Array.from({length:10}, (_,i) => ({target:`target-${i}`,
		kind:'link', line:i+1, syntax:'wiki'}));
	occurrences[0].target = 'target-0#missing';
	occurrences[2].target = 'photo.pdf';
	const report = await runDiagnostics({...options, selected:['manifest','properties','links','anchors','portability'],
		registeredPaths:[relative,'libraries/other'],
		collectLinks:source => source === `${relative}/name.md` ? occurrences : [],
		resolveLink:({target}) => {
			if (target === 'target-0') return {status:'resolved', path:'libraries/other/other.md', anchor:'missing'};
			if (target === 'target-1' || target === 'photo.pdf') return {status:'missing'};
			if (target === 'target-8' || target === 'target-9') return {status:'unknown'};
			return {status:'resolved', path:`${relative}/notes/target.md`};
		}});
	assert.equal(report.environment,'desktop');
	assert.equal(report.library.id,id);
	assert.equal(result(report,'manifest').status,'passed');
	assert.deepEqual(codes(result(report,'properties')),['invalid-frontmatter']);
	const links = result(report,'links');
	assert.equal(links.status,'partial');
	assert.equal(links.coverage.checked,8);
	assert.equal(links.coverage.unknown,3);
	assert.deepEqual(codes(links),['cross-library-link','uncreated-note','missing-attachment','unverified-link','unverified-link','unverified-property-links']);
	assert.equal(links.diagnostics[0].evidence,'libraries/other/other.md');
	assert.deepEqual(codes(result(report,'anchors')),['missing-anchor','unverified-property-links']);
	assert.deepEqual(codes(result(report,'portability')),['external-library-dependency','unverified-property-links']);
	assert.match(result(report,'portability').diagnostics[0].evidence,/所属库 libraries\/other/u);
	assert.match(report.logPath,/^\.log\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[\da-f-]+\.json$/u);
});

test('manifest reports missing registration and duplicate evidence independently', async t => {
	const {options} = await fixture(t);
	const inspect = async overrides => result(await runDiagnostics({...options,selected:['manifest'],...overrides}),'manifest');
	const known = await inspect({});
	assert.equal(known.status,'passed');
	assert.equal(known.coverage.unknown,0);
	assert.equal(known.reason,undefined);

	const duplicateUnknown = await inspect({duplicate:undefined});
	assert.equal(duplicateUnknown.status,'partial');
	assert.equal(duplicateUnknown.coverage.checked,known.coverage.checked - 1);
	assert.equal(duplicateUnknown.coverage.unknown,1);
	assert.match(duplicateUnknown.reason,/身份重复检查结果/u);
	assert.deepEqual(codes(duplicateUnknown),[]);

	const registrationUnknown = await inspect({registered:undefined});
	assert.equal(registrationUnknown.coverage.unknown,1);
	assert.match(registrationUnknown.reason,/Vault 登记状态/u);
	const bothUnknown = await inspect({registered:undefined,duplicate:undefined});
	assert.equal(bothUnknown.status,'partial');
	assert.equal(bothUnknown.coverage.checked,known.coverage.checked - 2);
	assert.equal(bothUnknown.coverage.unknown,2);
	assert.ok(bothUnknown.reason.includes(registrationUnknown.reason));
	assert.ok(bothUnknown.reason.includes(duplicateUnknown.reason));

	const duplicateFound = await inspect({duplicate:true});
	assert.equal(duplicateFound.status,'findings');
	assert.deepEqual(duplicateFound.coverage,known.coverage);
	assert.deepEqual(codes(duplicateFound),['duplicate-library']);
});

test('offline ignores literal examples, checks explicit local paths and does not claim Obsidian short-link resolution', async t => {
	const {options,put} = await fixture(t);
	await put('name.md', [
		'---','refs:','  - "[[short-property]]"','---',
		'[[short-title]]','[Known](./notes/target.md#Local%20heading)','![[attachment.pdf]]','![Figure](./missing.png)',
		'[[#^bad]]', '\\[[escaped]]', '`[[code]]`', '$[[math]]$',
		'```dataview','[[query]]','%%','```','%% [[comment]] %%','<!-- [[html-comment]] -->',
		'{{[[template]]}}','<% [[templater]] %>', '[Web](https://example.com)',
	].join('\n'));
	const report = await runDiagnostics({...options, selected:['links','anchors']});
	const links = result(report,'links');
	assert.equal(links.status,'partial');
	assert.equal(links.coverage.checked,3);
	assert.equal(links.coverage.unknown,3);
	assert.match(links.reason,/自动化代码块/u);
	assert.deepEqual(codes(links),['dynamic-block-skipped','unverified-link','unverified-link','missing-attachment','unverified-link']);
	assert.equal(links.diagnostics.find(item => item.code === 'missing-attachment').line,8);
	assert.deepEqual(codes(result(report,'anchors')),['dynamic-block-skipped','missing-anchor']);
});

test('offline resolves relative wikilinks in properties and Base embeds', async t => {
	const {options,put} = await fixture(t);
	await put('Views/Journal.base','views:\n  - type: table\n    name: Local View\n');
	await put('notes/example.md', [
		'---','refs: ["[[./target|Local note]]"]','---',
		'![[../Views/Journal.base#Local View]]','![[../Views/missing.base]]','[[../../same/target]]',
	].join('\n'));
	const report = await runDiagnostics({...options, selected:['links','anchors','portability']});
	const links = result(report,'links');
	assert.deepEqual(links.diagnostics.map(({code,line}) => [code,line]),[['missing-attachment',5],['unverified-link',6]]);
	assert.deepEqual(links.coverage,{checked:3,skipped:0,unknown:1});
	assert.deepEqual(result(report,'anchors').coverage,{checked:1,skipped:0,unknown:0});
	assert.deepEqual(result(report,'portability').diagnostics,[]);
});

test('scan gaps affect checks that need to read the file', async t => {
	const {options,put} = await fixture(t);
	const selected = ['manifest','properties','links','anchors','canvas','bases','bindings','portability'];
	const invalidUtf8 = Buffer.from([0xff]);
	await put('notes/unreadable.md',invalidUtf8);
	const markdown = await runDiagnostics({...options,selected});
	for (const id of ['properties','links','anchors','bases','portability']) {
		const check = result(markdown,id);
		assert.equal(check.status,'partial',id);
		assert.equal(check.coverage.unknown,1,id);
		assert.match(check.reason,/部分 Markdown 文件未能读取/u);
		assert.deepEqual(check.diagnostics.map(({code,file}) => [code,file]),[['unreadable-note','notes/unreadable.md']]);
	}
	for (const id of ['canvas','manifest','bindings']) assert.equal(result(markdown,id).coverage.unknown,0,id);

	await put('notes/unreadable.md','# Now readable');
	await put('private.base',invalidUtf8);
	await put('invalid.base','views: [3]');
	const baseFile = await runDiagnostics({...options,selected});
	const bases = result(baseFile,'bases');
	assert.equal(bases.status,'partial');
	assert.deepEqual(bases.coverage,{checked:1,skipped:1,unknown:1});
	assert.deepEqual(bases.diagnostics.map(({code,file}) => [code,file]),[
		['base-views','invalid.base'],['unreadable-file','private.base'],
	]);
	assert.match(bases.reason,/未能读取/u);
	assert.doesNotMatch(bases.reason,/动态表达式/u);
	for (const id of selected.filter(id => id !== 'bases')) assert.equal(result(baseFile,id).coverage.unknown,0,id);
});

test('selected rules read only their required content in both legacy and installed libraries', async t => {
	for (const kit of [false,true]) await t.test(kit?'installed':'legacy',async t => {
		const {options,root,put} = await fixture(t);
		await put('name.md','\uFFFD Markdown unrelated to Canvas\n');
		await put('map.canvas',JSON.stringify({nodes:[{id:'expected',type:'file',x:0,y:0,width:200,height:100,
			file:relative+'/notes/target.md',subpath:'#Local heading'}]}));
		await put('checks/checker.mjs','export default () => [];');
		if (kit) {
			const entries = Object.entries(checkKitFiles());
			for (const [file,source] of entries) await put(file,source);
			await put('kb.toml',writeCheckKit(manifest,{protocol:1,version:checkKitVersion,
				digests:Object.fromEntries(entries.map(([file,source])=>[file,digest(source)]))}));
		}
		const open = fs.open;
		const readdir = fs.readdir;
		const readNotes = [];
		const readDirs = [];
		const opened = t.mock.method(fsPromises,'open',async (target,...args) => {
			if (target.endsWith('.md')) readNotes.push(path.relative(root,target));
			return await open(target,...args);
		});
		const listed = t.mock.method(fsPromises,'readdir',async (target,...args) => {
			readDirs.push(path.relative(root,target));
			return await readdir(target,...args);
		});
		syncBuiltinESMExports();
		try {
			const manifestOnly = await runDiagnostics({...options,selected:['manifest']});
			assert.equal(result(manifestOnly,'manifest').status,'passed');
			assert.deepEqual(readNotes,[]);
			assert.ok(readDirs.includes('notes'));
			readDirs.length = 0;
			const unapproved = await runDiagnostics({...options,selected:['fixture.check']});
			assert.deepEqual(codes(result(unapproved,'fixture.check')),['checker-untrusted']);
			assert.deepEqual(readNotes,[]);
			assert.deepEqual(readDirs,[]);
			const canvasOnly = await runDiagnostics({...options,selected:['canvas']});
			assert.equal(result(canvasOnly,'canvas').status,'passed');
			assert.deepEqual(readNotes,[path.join('notes','target.md')]);
		} finally {
			opened.mock.restore();listed.mock.restore();syncBuiltinESMExports();
		}
	});
});

test('unscannable subdirectories leave affected paths and rules unverified', async t => {
	const {root,options,put} = await fixture(t);
	await put('protected/start.md','# Unseen');
	await put('kb.toml',manifest.replace('notes = "notes"','notes = "notes"\ninbox = "protected/subfolder"')
		.replace('entry = "name.md"','entry = "protected/start.md"'));
	await put('name.md','[Unseen](./protected/start.md)\n[Clearly missing](./gone.md)');
	const selected = ['manifest','properties','links','anchors','canvas','bases','bindings','portability'];
	const report = await withUnscannableDirectory(t,path.join(root,'protected'),() => runDiagnostics({...options,selected}));
	const libraryManifest = result(report,'manifest');
	assert.equal(libraryManifest.status,'partial');
	assert.equal(libraryManifest.coverage.unknown,2);
	assert.deepEqual(libraryManifest.diagnostics.map(({code,file,evidence}) => [code,file,evidence]),[
		['manifest-path-unverified','protected/start.md','protected'],
		['manifest-path-unverified','protected/subfolder','protected'],
	]);
	for (const id of ['properties','links','anchors','canvas','bases','portability']) {
		const check = result(report,id);
		assert.equal(check.status,'partial',id);
		assert.match(check.reason,/部分目录无法遍历/u);
		assert.ok(check.diagnostics.some(item => item.code === 'unreadable-directory' && item.file === 'protected'),id);
	}
	assert.equal(result(report,'bindings').coverage.unknown,0);
	const links = result(report,'links');
	assert.deepEqual(links.diagnostics.map(({code,file,line}) => [code,file,line]),[
		['unreadable-directory','protected',undefined],['unverified-link','name.md',1],['missing-link-target','name.md',2],
	]);
	assert.match(links.diagnostics[1].message,/链接目标所在的目录/u);
});

test('Tasks query blocks identify their source while body links still use available evidence', async t => {
	const {options,put} = await fixture(t);
	await put('name.md',[
		'---','title: Tasks','---',
		'[Checked](./notes/target.md#Local%20heading)',
		'```tasks','not done','[[dynamic-missing]]','```',
		'[Missing](./missing.md)',
		'~~~dataview','LIST','~~~',
		'```txt','[[literal-missing]]','```',
	].join('\n'));
	const selected = ['links','anchors','portability'];
	const offline = await runDiagnostics({...options,selected});
	const visited = [];
	const native = await runDiagnostics({...options,selected,
		collectLinks: source => source.endsWith('/name.md') ? [
			{target:'./notes/target.md#Local%20heading',line:4,kind:'link',syntax:'markdown'},
			{target:'dynamic-missing',line:7,kind:'link',syntax:'wiki'},
			{target:'./missing.md',line:9,kind:'link',syntax:'markdown'},
		] : [],
		resolveLink: ({target}) => {
			visited.push(target);
			return target === './notes/target.md' ? {status:'resolved',path:`${relative}/notes/target.md`,anchor:'resolved'} : {status:'missing'};
		},
	});
	assert.deepEqual(visited,['./notes/target.md','./missing.md']);
	for (const report of [offline,native]) {
		for (const id of selected) {
			const check = result(report,id);
			assert.equal(check.coverage.unknown,0,id);
			// The second scan also skips the newly generated .log directory.
			assert.equal(check.coverage.skipped,report === offline ? 2 : 3,id);
			assert.deepEqual(check.diagnostics.filter(item => item.code === 'dynamic-block-skipped').map(({file,line,evidence}) => [file,line,evidence]),[
				['name.md',5,'tasks'],['name.md',10,'dataview'],
			]);
		}
		assert.deepEqual(result(report,'links').diagnostics.filter(item => item.severity === 'error').map(({code,line}) => [code,line]),[
			['missing-link-target',9],
		]);
		assert.equal(result(report,'anchors').coverage.checked,1);
	}
});

test('closed malformed frontmatter leaves property links unverified while retaining cached body links', async t => {
	const {options,put} = await fixture(t);
	await put('name.md','---\nrefs: ["[[property]]"\n---\n[Missing](./gone.md)\n');
	const report = await runDiagnostics({...options,selected:['properties','links','anchors','portability'],
		collectLinks: source => source.endsWith('/name.md') ? [{target:'./gone.md',line:4,kind:'link',syntax:'markdown'}] : [],
		resolveLink: () => ({status:'missing'}),
	});
	const properties = result(report,'properties');
	assert.equal(properties.status,'findings');
	assert.equal(properties.coverage.unknown,0);
	assert.deepEqual(codes(properties),['invalid-frontmatter']);
	for (const id of ['links','anchors','portability']) {
		const check = result(report,id);
		assert.equal(check.status,'partial',id);
		assert.equal(check.coverage.unknown,1,id);
		assert.match(check.reason,/Markdown 属性中的链接未能验证/u);
		assert.ok(check.diagnostics.some(item => item.code === 'unverified-property-links' && item.file === 'name.md' &&
			item.line === properties.diagnostics[0].line),id);
	}
	assert.ok(result(report,'links').diagnostics.some(item => item.code === 'missing-link-target' && item.line === 4));
});

test('unclosed frontmatter leaves both body anchors and embedded Bases unverified', async t => {
	const {options,put} = await fixture(t);
	await put('notes/target.md','---\nname: Example\n\nA block. ^visible\n```base\nviews: [3]\n```\n');
	await put('name.md','[Anchor](./notes/target.md#^visible)');
	const report = await runDiagnostics({...options,selected:['anchors','bases']});
	assert.deepEqual(result(report,'anchors').diagnostics.map(({file,line,code}) => [file,line,code]),[
		['name.md',1,'unverified-anchor'],['notes/target.md',1,'unverified-property-links'],
	]);
	assert.deepEqual(result(report,'bases').diagnostics.map(({file,line,code}) => [file,line,code]),[
		['notes/target.md',1,'unverified-markdown-body'],
	]);
	assert.match(result(report,'bases').reason,/正文无法与属性分开/u);
});

test('Canvas validates structure, and Bases report structural errors and unevaluated expressions', async t => {
	const {options,put} = await fixture(t);
	const node = {x:0,y:0,width:150,height:100};
	await put('sample.canvas',JSON.stringify({nodes:[
		{...node,id:'known',type:'file',file:`${relative}/notes/target.md`,subpath:'#Local heading'},
		{...node,id:'known',type:'file',file:`${relative}/notes/lost.png`},
		{...node,id:'foreign',type:'file',file:'libraries/elsewhere/note.md'},
		{...node,id:'text',type:'text',text:'[Fixed](./notes/target.md) [Broken](./missing.md)'},
		{...node,id:'group',type:'group',background:`${relative}/notes/bg.png`,backgroundStyle:'cover'},
	],edges:[{id:'broken',fromNode:'known',toNode:'absent'}]}));
	await put('validation.base','filters: {and: [1]}\nviews: [{type: table, name: Report}]\n');
	await put('dynamic.base','formulas: {rating: "if(book, 1, 0)"}\nviews: [{type: table, name: Report}]\n');
	await put('name.md','# 示例\n\n```base\nviews: [42]\n```\n');
	const report = await runDiagnostics({...options,selected:['canvas','bases']});
	const canvas = result(report,'canvas'), bases = result(report,'bases');
	assert.equal(canvas.status,'partial');
	assert.deepEqual(codes(canvas),['canvas-duplicate-node','canvas-target-missing','canvas-target-unverified',
		'missing-link-target','canvas-target-missing','canvas-dangling-edge']);
	assert.equal(bases.status,'partial');
	assert.equal(bases.coverage.unknown,1);
	assert.deepEqual(codes(bases),['base-filter','base-views']);
	assert.equal(bases.diagnostics[1].line,3);
});

test('Canvas retains ordinary exclusions and reports deferred template links separately', async t => {
	const inspect = async text => {
		const {options,put} = await fixture(t);
		await put('checks/ignored.canvas','not JSON');
		await put('sample.canvas',JSON.stringify({nodes:[{x:0,y:0,width:150,height:100,id:'text',type:'text',text}]}));
		return result(await runDiagnostics({...options,selected:['canvas']}),'canvas');
	};
	const ordinary = '[Fixed](./notes/target.md) [Web](https://example.com)';
	const ordinaryCheck = await inspect(ordinary);
	assert.equal(ordinaryCheck.status,'passed');
	assert.deepEqual(ordinaryCheck.coverage,{checked:2,skipped:2,unknown:0});
	assert.equal(ordinaryCheck.reason,undefined);
	assert.deepEqual(codes(ordinaryCheck),[]);

	const dynamic = `${ordinary} [[{{date}}]] [Heading](./notes/target.md#{{title}})`;
	const deferredCheck = await inspect(dynamic);
	assert.equal(deferredCheck.status,'findings');
	assert.deepEqual(deferredCheck.coverage,{checked:2,skipped:4,unknown:0});
	assert.match(deferredCheck.reason,/待实例化/u);
	assert.deepEqual(deferredCheck.diagnostics.map(({file,severity,code}) => [file,severity,code]),[
		['sample.canvas','info','template-link-deferred'],['sample.canvas','info','template-link-deferred'],
	]);

	const partialCheck = await inspect(`${dynamic} [[Short title]]`);
	assert.equal(partialCheck.status,'partial');
	assert.deepEqual(partialCheck.coverage,{checked:2,skipped:4,unknown:1});
	assert.ok(partialCheck.reason.includes(deferredCheck.reason));
	assert.match(partialCheck.reason,/未能确认/u);
});

test('template diagnostics check stable links, defer variables, and validate named Base views', async t => {
	const {options,put} = await fixture(t);
	await put('templates/sample.md','[[固定说明]]\n[[{{date}}]]\n![[missing.md]]\n![[catalog.base#Missing View]]');
	await put('catalog.base','views: [{type: table, name: Available View}]\n');
	await put('notes/固定说明.md','# 固定说明');
	const requested = [];
	const report = await runDiagnostics({...options, selected:['links','anchors','portability'], registeredPaths:[relative,'libraries/other'],
		linkCandidates: ({target}) => target === '固定说明' ? ['libraries/other/固定说明.md',`${relative}/notes/固定说明.md`] : [],
		resolveLink:request => {
			requested.push(request.target);
			if (request.target === '固定说明') return {status:'resolved',path:'libraries/other/固定说明.md'};
			if (request.target === 'catalog.base') return {status:'resolved',path:`${relative}/catalog.base`,anchor:'unknown'};
			return {status:'missing'};
		}});
	assert.deepEqual(requested,['固定说明','missing.md','catalog.base']);
	assert.deepEqual(codes(result(report,'links')),['cross-library-link','template-link-deferred','missing-link-target']);
	assert.deepEqual(codes(result(report,'anchors')),['missing-base-view']);
	const cross = result(report,'portability').diagnostics.find(item => item.code === 'external-library-dependency');
	assert.match(cross.evidence,/所属库 libraries\/other.*同名候选.*notes\/固定说明\.md/u);
});

test('native Markdown paths use the same decoding as the clicked Obsidian link', async t => {
	const {options,put} = await fixture(t);
	await put('Probe.md','[Literal](./A%2520B.md)');
	await put('A%20B.md','literal percent');
	await put('A B.md','space');
	const source = relative + '/Probe.md';
	const report = await runDiagnostics({...options,selected:['links'],
		collectLinks: file => file === source ? [{kind:'link',target:'./A%20B.md',syntax:'markdown',decoded:true}] : [],
		resolveLink: request => ({status:request.target === './A%20B.md' ? 'resolved' : 'missing',path:relative+'/A%20B.md'}),
	});
	assert.deepEqual(result(report,'links').diagnostics,[]);
	assert.ok(result(report,'links').coverage.checked > 0);
});

test('footnotes, PDF page selectors and image dimensions keep their own syntax and source locations', async t => {
	const {options,put} = await fixture(t);
	await put('manual.pdf','Fixture for target existence.');
	await put('image.png','Fixture for target existence.');
	await put('name.md',[
		'---','title: Media','---',
		'Confirmed[^defined] Missing[^missing] and inline ^[正文].',
		'[^defined]: Defined text.',
		'`[^inline-code]` <!-- [^html-comment] --> %% [^obsidian-comment] %% $[^formula]$',
		'    [^indented-code]', '```md', '[^fenced-code]', '```', '\\[^escaped]',
		'![[libraries/示例库/manual.pdf#page=0]]',
		'![[libraries/示例库/manual.pdf#page=-1]]',
		'[Decimal](./manual.pdf#page=1.5)',
		'![[libraries/示例库/manual.pdf#page=3&height=400]]',
		'![[libraries/示例库/image.png|100x145]]',
		'![Photo|100](./image.png)',
		'![[libraries/示例库/manual.pdf#selection=1,2,3,4]]',
		'![[libraries/示例库/manual.pdf#page=3&annotation=note]]',
	].join('\n'));
	const report = await runDiagnostics({...options,selected:['links','anchors']});
	const links = result(report,'links');
	assert.deepEqual(links.diagnostics.map(({code,line,evidence}) => [code,line,evidence]),[['missing-footnote-definition',4,'missing']]);
	assert.equal(result(report,'anchors').status,'partial');
	assert.deepEqual(result(report,'anchors').diagnostics.map(({code,line}) => [code,line]),[
		['invalid-pdf-page',12], ['invalid-pdf-page',13], ['invalid-pdf-page',14], ['unverified-pdf-page',15],
		['unverified-pdf-location',18], ['unverified-pdf-location',19], ['unverified-pdf-page',19],
	]);
	const native = await runDiagnostics({...options,selected:['links','anchors'],
		collectLinks:source => source.endsWith('/name.md') ? [{target:'image.png|100x145',kind:'embed',line:16,syntax:'wiki'}] : [],
		resolveLink:link => {assert.equal(link.target,'image.png'); assert.equal(link.fragment,undefined); return {status:'resolved',path:`${relative}/image.png`};},
	});
	assert.deepEqual(codes(result(native,'links')),['missing-footnote-definition']);
	assert.equal(result(native,'anchors').status,'skipped');
});

test('only placeholder-caused template YAML errors defer and ordinary Base text stays literal', async t => {
	const {options,put} = await fixture(t);
	await put('templates/static.md','---\nname: [\n---\n');
	await put('templates/dynamic.md','---\ndate: {{date}}\n---\n');
	await put('templates/mixed.md','---\ndate: {{date}}\nname: [\n---\n');
	await put('sample.base','properties:\n  note.status: {displayName: "__WIKI_PATH__ __CATEGORY_PATH__"}\nviews: [{type: table, name: Report}]\n');
	const report = await runDiagnostics({...options,selected:['properties','bases']});
	const properties = result(report,'properties');
	assert.equal(properties.coverage.unknown,1);
	assert.deepEqual(properties.diagnostics.map(item => item.file),['templates/mixed.md','templates/static.md']);
	assert.equal(result(report,'bases').status,'passed');
});

test('trusted check executes approved bytes on portable context and writes one log per concurrent invocation', async t => {
	const {root,options,put} = await fixture(t);
	const script = `export default function check({template,manifest,libraryRoot,notes}) {
		if (libraryRoot !== ${JSON.stringify(relative)} || manifest.version !== 2 || template.id !== 'fixture' ||
			manifest.paths.notes !== 'notes' || !manifest.preferences.disablePush || 'privateToken' in manifest.preferences ||
			manifest.variables.threshold !== 7 || template.variables.threshold !== 5 ||
			'source' in template.checks[0] || !notes.some(note => note.path === 'notes/target.md' && note.properties.status === 'ready'))
			throw new Error('Unexpected context');
		console.log('This is not the CLI response');
		return [{severity:'warning',code:'expected',file:'name.md',line:1,message:'A real finding.'}];
	}`;
	await put('checks/checker.mjs',script);
	const list = await listSpecialChecks(root);
	assert.equal(list.checks[0].digest,digest(script));
	const accepted = {...options,selected:['fixture.check'],trustedDigests:[digest(script)]};
	const pair = await Promise.all([runDiagnostics(accepted),runDiagnostics(accepted)]);
	assert.ok(pair.every(report => report.status === 'findings' && result(report,'fixture.check').diagnostics[0].code === 'expected'));
	assert.notEqual(pair[0].logPath,pair[1].logPath);
	assert.deepEqual(new Set((await listDiagnosticHistory(root)).map(report => report.runId)),new Set(pair.map(report => report.runId)));
	const persisted = JSON.parse(await fs.readFile(path.join(root,pair[0].logPath),'utf8'));
	assert.equal(persisted.logPath,pair[0].logPath);
	assert.equal(JSON.stringify(persisted).includes('This is not the CLI response'),false);
	await put('checks/checker.mjs',script+'\n// A local edit requires new approval.');
	const rejected = await runDiagnostics(accepted);
	assert.equal(rejected.status,'partial');
	assert.equal(result(rejected,'fixture.check').status,'partial');
	assert.equal(result(rejected,'fixture.check').coverage.unknown,1);
	assert.deepEqual(codes(result(rejected,'fixture.check')),['checker-untrusted']);
	assert.ok(rejected.logPath);
});

test('cancelling trusted common and template checks waits for child exit and keeps completed results', async t => {
	for (const [checkId,scriptPath] of [['properties','checks/common/properties.mjs'],['fixture.check','checks/checker.mjs']]) {
		await t.test(checkId,async t => {
			const {options, root, put} = await fixture(t);
			const completed = await runDiagnostics({...options,selected:['manifest']});
			const pidFile = path.join(root,'checks','child.pid');
			const source = `import {writeFileSync} from 'node:fs';
				import {spawn} from 'node:child_process';
				export default () => {
					const child = spawn(process.execPath,['--eval','setInterval(() => {}, 10000)'],{stdio:'ignore',windowsHide:true});
					writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid,child.pid]));
					for (;;) {}
				};`;
			await put(scriptPath,source);
			if (checkId === 'properties') {
				const officialManifest = checkKitFiles()['checks/common/manifest.mjs'];
				await put('checks/common/manifest.mjs',officialManifest);
				await put('kb.toml',writeCheckKit(manifest,{protocol:1,version:checkKitVersion,digests:{
					'checks/common/manifest.mjs':digest(officialManifest),[scriptPath]:digest(source),
				}}));
			}
			const controller = new AbortController();
			const running = runDiagnostics({...options,selected:['manifest',checkId,'bindings'],
				trustedDigests:[digest(source)],signal:controller.signal,timeoutMs:8000});
			let pids;
			try {
				for (let attempt=0; attempt<160 && !pids; attempt++) {
					const text = await fs.readFile(pidFile,'utf8').catch(error => {
						if (error.code !== 'ENOENT') throw error;
					});
					if (text?.endsWith(']')) pids = JSON.parse(text);
					if (!pids) await delay(25);
				}
				assert.ok(pids?.every(Number.isSafeInteger),'the selected checker and its child started');
				for (const pid of pids) assert.doesNotThrow(()=>process.kill(pid,0));
			} finally {
				controller.abort();
				await running;
			}
			const cancelled = await running;
			assert.equal(cancelled.status,'cancelled');
			assert.deepEqual(cancelled.checks.map(row=>[row.id,row.status]),[
				['manifest','passed'],[checkId,'not-run'],['bindings','not-run'],
			]);
			for (const pid of pids) {
				// Linux can briefly retain a dead grandchild as a zombie while its new parent reaps it.
				let running = true;
				for (let attempt=0; attempt<100 && running; attempt++) {
					try {
						process.kill(pid,0);
						if (process.platform === 'linux') {
							const stat = await fs.readFile(`/proc/${pid}/stat`,'utf8');
							running = stat.slice(stat.lastIndexOf(')')+2,stat.lastIndexOf(')')+3) !== 'Z';
						}
					} catch (error) {
						if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
						running = false;
					}
					if (running) await delay(10);
				}
				assert.equal(running,false,`process ${pid} stopped`);
			}
			assert.equal(cancelled.logPath,undefined);
			assert.deepEqual((await listDiagnosticHistory(root)).map(report=>report.runId),[completed.runId]);
		});
	}
});

test('cancelling during scan or before history publication leaves existing reports intact', async t => {
	const {options, root} = await fixture(t);
	const selected = ['manifest','properties','fixture.check'];
	const complete = await runDiagnostics({...options,selected:['manifest']});
	const beforeStart = await runDiagnostics({...options,selected:'all',signal:AbortSignal.abort(),
		knownTemplateChecks:[{id:'fixture.check',name:'Previously listed template check'}]});
	assert.equal(beforeStart.status,'cancelled');
	assert.equal(result(beforeStart,'fixture.check').status,'not-run');
	assert.equal(result(beforeStart,'fixture.check').name,'Previously listed template check');
	const readdir = fs.readdir;
	const scan = new AbortController();
	const mockScan = t.mock.method(fsPromises,'readdir',async (target,...args) => {
		if (target === path.join(root,'notes')) scan.abort();
		return await readdir(target,...args);
	});
	syncBuiltinESMExports();
	try {
		const cancelled = await runDiagnostics({...options,selected,signal:scan.signal});
		assert.equal(cancelled.status,'cancelled');
		assert.deepEqual(cancelled.checks.map(row=>[row.id,row.status]),selected.map(id=>[id,'not-run']));
	} finally {mockScan.mock.restore();syncBuiltinESMExports();}
	const realpath = fs.realpath;
	const publish = new AbortController();
	const mockLog = t.mock.method(fsPromises,'realpath',async (target,...args) => {
		const resolved = await realpath(target,...args);
		if (target === path.join(root,'.log')) publish.abort();
		return resolved;
	});
	syncBuiltinESMExports();
	try {
		const cancelled = await runDiagnostics({...options,selected:['manifest'],signal:publish.signal});
		assert.equal(cancelled.status,'cancelled');
		assert.equal(cancelled.checks[0].status,'passed');
		assert.equal(cancelled.logPath,undefined);
		assert.deepEqual(await fs.readdir(path.join(root,'.log')),[path.basename(complete.logPath)]);
		await assert.rejects(listDiagnosticHistory(root,publish.signal),{name:'AbortError'});
	} finally {mockLog.mock.restore();syncBuiltinESMExports();}
});

test('log writes work without hard links and never replace an existing report', async t => {
	const {options,root,vault} = await fixture(t);
	const unsupported = t.mock.method(fsPromises,'link',() => {
		throw Object.assign(new Error('This volume does not support hard links'),{code:'ENOTSUP'});
	});
	syncBuiltinESMExports();
	try {
		const existing = await runDiagnostics({...options,selected:['manifest']});
		assert.ok(existing.logPath);
		const duplicate = {...existing,logPath:undefined,checks:[]};
		await saveDiagnosticReport(root,vault,duplicate);
		assert.ok(duplicate.logError);
		assert.deepEqual((await listDiagnosticHistory(root))[0],JSON.parse(JSON.stringify(existing)));
		assert.equal(unsupported.mock.callCount(),0);
	} finally {unsupported.mock.restore();syncBuiltinESMExports();}
});

test('history preserves legacy reports and validates freshness within the original evidence scope', async t => {
	const {root,options,put} = await fixture(t);
	const manifestOnly = await runDiagnostics({...options,selected:['manifest']});
	assert.match(manifestOnly.engineVersion,/^\d+\.\d+\.\d+$/u);
	assert.ok(manifestOnly.inputVersion.files.includes('kb.toml'));
	assert.ok(!manifestOnly.inputVersion.files.some(file => file.endsWith('.md')));
	assert.equal(await diagnosticFreshness(options,manifestOnly),'fresh');
	await put('notes/target.md','# Replacement body\n');
	assert.equal(await diagnosticFreshness(options,manifestOnly),'fresh');
	const properties = await runDiagnostics({...options,selected:['properties']});
	assert.equal(await diagnosticFreshness(options,properties),'fresh');
	// Creating another report does not make the previous report stale.
	assert.equal(await diagnosticFreshness(options,manifestOnly),'fresh');
	await put('notes/target.md','# Replacement body\nEdited later\n');
	assert.equal(await diagnosticFreshness(options,properties),'stale');
	assert.equal(await diagnosticFreshness(options,manifestOnly),'fresh');
	await put('notes/new.md','# Added later');
	assert.equal(await diagnosticFreshness(options,manifestOnly),'stale');
	const old = {...manifestOnly};
	delete old.engineVersion;
	delete old.inputVersion;
	old.checks = old.checks.map(check => {const row={...check};delete row.rule;return row;});
	await put(old.logPath,JSON.stringify(old));
	const restored = (await listDiagnosticHistory(root)).find(report=>report.runId===old.runId);
	assert.equal(restored.status,old.status);
	assert.equal(restored.checks[0].rule,undefined);
	assert.equal(await diagnosticFreshness(options,restored),'unknown');
});

test('historical comparisons distinguish new, resolved, and relocated findings', async t => {
	const {options,put} = await fixture(t);
	const bad = '---\nstatus: [\n---\n# Body\n';
	await put('notes/remains.md',bad);
	await put('notes/resolved.md',bad);
	const first = await runDiagnostics({...options,selected:['properties','manifest']});
	await put('notes/remains.md',bad.replace('status: [','valid: string\nstatus: ['));
	await put('notes/resolved.md','---\nstatus: ready\n---\n');
	await put('notes/new.md',bad);
	const second = await runDiagnostics({...options,selected:['properties']});
	const difference = compareDiagnosticReports(first,second);
	const files = rows => rows.map(({diagnostic})=>diagnostic.file);
	assert.deepEqual(files(difference.introduced),['notes/new.md']);
	assert.deepEqual(files(difference.resolved),['notes/resolved.md']);
	assert.deepEqual(files(difference.remaining),['notes/remains.md']);
	assert.notEqual(result(first,'properties').diagnostics[0].line,difference.remaining[0].diagnostic.line);
	assert.deepEqual(difference.unavailableChecks,['manifest']);
	const partial = {...second,checks:second.checks.map(check=>({...check,status:'partial',coverage:{...check.coverage,unknown:1}}))};
	assert.deepEqual(compareDiagnosticReports(first,partial).resolved,[]);
	assert.deepEqual(compareDiagnosticReports(first,{...second,environment:'desktop'}).introduced,[]);
});

test('selecting only an approved special check identifies files and directories omitted from its input', async t => {
	const {root,options,put} = await fixture(t);
	const script = `export default ({notes}) => {
		if (notes.length !== 3 || !notes.some(note => note.path === 'notes/target.md'))
			throw new Error('Unexpected notes in script input');
		return [];
	}`;
	await put('checks/checker.mjs',script);
	await put('protected/hidden.md','# Hidden');
	await put('notes/unreadable.md',Buffer.from([0xff]));
	await put('notes/invalid.md','---\ntitle: [\n---\n# Body');
	const report = await withUnscannableDirectory(t,path.join(root,'protected'),() =>
		runDiagnostics({...options,selected:['fixture.check'],trustedDigests:[digest(script)]}));
	assert.deepEqual(report.checks.map(check => check.id),['fixture.check']);
	const check = result(report,'fixture.check');
	assert.equal(check.status,'partial');
	assert.deepEqual(check.coverage,{checked:1,skipped:0,unknown:3});
	assert.deepEqual(check.diagnostics.map(({file,line,code}) => [file,line,code]),[
		['protected',undefined,'unreadable-directory'],
		['notes/unreadable.md',undefined,'unreadable-note'],
		['notes/invalid.md',2,'checker-input-invalid-properties'],
	]);
	assert.match(check.reason,/目录无法遍历/u);
	assert.match(check.reason,/Markdown 文件未能读取/u);
	assert.match(check.reason,/属性无法解析/u);
});

test('template checks retain findings and checked totals when detail exceeds the child output budget', async t => {
	const {root,options,put} = await fixture(t);
	const source = `export default () => ({
		findings: Array.from({length:440}, () => ({severity:"warning", code:"test-check", file:"name.md", message:"x".repeat(1000)})),
		checkedItems: Array.from({length:5000}, () => ({file:"name.md", subject:"Property", outcome:"Fits " + "字".repeat(180), count:2}))
	});`;
	await put('checks/checker.mjs',source);
	const report = await runDiagnostics({...options,selected:['fixture.check'],trustedDigests:[digest(source)]});
	const check = result(report,'fixture.check');
	assert.equal(check.status,'findings');
	assert.equal(check.coverage.checked,10000);
	assert.equal(check.diagnostics.length,440);
	assert.ok(check.checkedItems.length > 0 && check.checkedItems.length < 4000);
	assert.match(check.reason,/10000/u);
	assert.ok(report.logPath,report.logError);
	const [saved] = await listDiagnosticHistory(root);
	assert.deepEqual(result(saved,'fixture.check').checkedItems,check.checkedItems);
});

test('reports checker failures, excessive output, timeouts, and log failure without exposing exceptions', async t => {
	const {root,vault,options,put} = await fixture(t);
	for (const [source,expected] of [
		['export default () => [{severity:"error", code:"bad", file:"../escape.md", message:"Invalid"}];','checker-output'],
		['export default () => ({findings:[],checkedItems:[{file:"../escape.md",subject:"Invalid path",outcome:"Not in scope"}]});','checker-output'],
		['export default () => { throw new Error("private exception body"); };','checker-execution'],
		['export default () => { console.log("X".repeat(600000)); return []; };','checker-output-limit'],
		['export default () => { for (;;) {} };','checker-timeout'],
	]) {
		await put('checks/checker.mjs',source);
		const report = await runDiagnostics({...options, selected:['fixture.check'],trustedDigests:[digest(source)],timeoutMs:1500});
		assert.equal(report.status,'failed');
		assert.deepEqual(codes(result(report,'fixture.check')),[expected]);
		assert.ok(report.logPath);
		assert.ok(!JSON.stringify(report).includes('private exception body'));
	}
	const redirect = path.join(vault,'foreign');
	await fs.mkdir(redirect);
	const unsafeRoot = path.join(root,'unsafe');
	await fs.mkdir(unsafeRoot);
	await fs.writeFile(path.join(unsafeRoot,'kb.toml'),'version = 1\n');
	await fs.symlink(redirect,path.join(unsafeRoot,'.log'),'junction');
	const failed = await runDiagnostics({...options,libraryRoot:unsafeRoot,selected:['manifest']});
	assert.ok(failed.logError);
	assert.equal(failed.logPath,undefined);
	assert.deepEqual(await fs.readdir(redirect),[]);
});

test('Git-backed logs need the library ignore rule and stay out of git status', async t => {
	const {root,options} = await fixture(t);
	const git = (...args) => execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
	git('init','-q');
	const before = await runDiagnostics({...options,selected:['manifest']});
	assert.ok(before.logError);
	await fs.appendFile(path.join(root,'.git','info','exclude'),'\n/.log/\n');
	const after = await runDiagnostics({...options,selected:['manifest']});
	assert.ok(after.logPath);
	assert.equal(git('check-ignore','--',after.logPath),after.logPath);
	assert.doesNotMatch(git('status','--short','--untracked-files=all'),/\.log/u);
	git('add','-f','--',after.logPath);
	const tracked = await runDiagnostics({...options,selected:['manifest']});
	assert.match(tracked.logError,/已跟踪/u);
	assert.equal(tracked.logPath,undefined);
});

test('English setting translates native checks and preserves template text and file evidence', async t => {
	const {options,put} = await fixture(t);
	const script = `export default () => [{severity:'warning',code:'author-text',file:'原文.md',message:'保留作者原话',evidence:'原始证据'}]`;
	await put('checks/checker.mjs',script);
	await put('原文.md','[[尚未解析]]\n![Figure](./缺少附件.png)');
	setLanguage('en');
	try {
		const report = await runDiagnostics({...options,registered:undefined,selected:['manifest','links','bases','fixture.check'],trustedDigests:[digest(script)]});
		assert.equal(result(report,'manifest').name,'Manifest and registration');
		assert.match(result(report,'manifest').reason,/verify vault registration/u);
		assert.equal(result(report,'bases').reason,'There was nothing to check for this rule.');
		const links = result(report,'links').diagnostics;
		assert.match(links.find(item => item.code === 'missing-attachment').message,/attachment is missing/u);
		assert.equal(links.find(item => item.code === 'unverified-link').evidence,'尚未解析');
		const author = result(report,'fixture.check');
		assert.equal(author.name,'专项');
		assert.deepEqual(author.diagnostics[0],{severity:'warning',code:'author-text',file:'原文.md',message:'保留作者原话',evidence:'原始证据',line:undefined});
	} finally {setLanguage('zh');}
});

test('compiled CLI uses pure JSON stdout from a Unicode path with no Obsidian runtime', async t => {
	const {root,vault,put} = await fixture(t);
	const script = `export default function check({libraryRoot}) {
		console.log('unexpected protocol output');
		return [{severity:'error',code:'example',file:'name.md',message:libraryRoot}];
	}`;
	await put('checks/checker.mjs',script);
	const cli = path.join(vault,'导出工具.cjs');
	await build({entryPoints:['src/diagnostics/cli.ts'],bundle:true,platform:'node',format:'cjs',outfile:cli});
	function invoke(...args) {
		try {return {status:0, stdout:execFileSync(process.execPath,[cli,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})};}
		catch (error) {return {status:error.status,stdout:error.stdout};}
	}
	const output = invoke('--library',root,'--vault-root',vault,'--config-dir','.settings','--checks','fixture.check','--trust-digest',digest(script));
	const report = JSON.parse(output.stdout);
	assert.equal(output.status,1);
	assert.equal(report.schemaVersion,1);
	assert.equal(report.environment,'offline');
	assert.equal(report.checks[0].diagnostics[0].message,relative);
	const list = JSON.parse(invoke('--library',root,'--list').stdout);
	assert.equal(list.checks[0].digest,digest(script));
	const scoped = ['--library',root,'--vault-root',vault,'--config-dir','.settings'];
	const history = JSON.parse(invoke(...scoped,'--history').stdout);
	assert.ok(history.reports.some(item => item.runId === report.runId));
	assert.equal(JSON.parse(invoke(...scoped,'--list').stdout).checks[0].digest,digest(script));
	const otherVault = path.join(vault,'Other vault');
	await fs.mkdir(otherVault);
	for (const mode of ['--list','--history']) {
		const mismatch = invoke('--library',root,'--vault-root',otherVault,mode);
		assert.equal(mismatch.status,2);
		assert.match(JSON.parse(mismatch.stdout).error,/--library/u);
		assert.ok(!mismatch.stdout.includes('Other vault'));
		const configFolder = invoke('--library',otherVault,'--vault-root',vault,'--config-dir','Other vault',mode);
		assert.equal(configFolder.status,2);
	}
	const located = invoke('--library',root,'--config-dir','.settings','--checks','fixture.check','--trust-digest',digest(script));
	assert.equal(located.status,1);
	assert.equal(JSON.parse(located.stdout).checks[0].diagnostics[0].message,relative);
	const help = invoke('--help');
	assert.equal(help.status,0);
	assert.match(JSON.parse(help.stdout).usage,/kb-check\.cjs --help/u);
	const secret = 'example-secret-canary';
	for (const [args,message] of [
		[['--private-option='+secret],/未知选项|Unknown option/u],
		[['--library','--list'],/--library.*缺少|Missing value for --library/u],
		[['--list'],/请使用 --library|library folder with --library/u],
		[['--help','--history'],/--help.*--list.*--history/u],
		[['--library',root,'--config-dir','../'+secret],/--config-dir/u],
		[['--library',root,'--checks',secret+'/?'],/--checks/u],
		[['--library',root,'--trust-digest',secret],/SHA-256/u],
		[['--library',path.join(vault,secret),'--list'],/找不到|does not exist/u],
		[['--library',cli,'--history'],/实际目录|real directory/u],
	]) {
		const bad = invoke(...args);
		assert.equal(bad.status,2);
		const failure = JSON.parse(bad.stdout);
		assert.equal(failure.status,'failed');
		assert.match(failure.error,message);
		assert.ok(!bad.stdout.includes(secret));
		assert.ok(!bad.stdout.includes('导出工具.cjs'));
	}
});
