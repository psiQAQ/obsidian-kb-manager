import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';
import {listDiagnosticHistory, listSpecialChecks, runDiagnostics} from '../src/diagnostics/index.ts';
import {setLanguage} from '../src/i18n.ts';

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
	assert.equal(links.coverage.unknown,2);
	assert.deepEqual(codes(links),['cross-library-link','uncreated-note','missing-attachment','unverified-link','unverified-link']);
	assert.equal(links.diagnostics[0].evidence,'libraries/other/other.md');
	assert.deepEqual(codes(result(report,'anchors')),['missing-anchor']);
	assert.deepEqual(codes(result(report,'portability')),['external-library-dependency']);
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
	assert.deepEqual(codes(links),['unverified-link','unverified-link','missing-attachment','unverified-link']);
	assert.equal(links.diagnostics.find(item => item.code === 'missing-attachment').line,8);
	assert.deepEqual(codes(result(report,'anchors')),['missing-anchor']);
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
	].join('\n'));
	const report = await runDiagnostics({...options,selected:['links','anchors']});
	const links = result(report,'links');
	assert.deepEqual(links.diagnostics.map(({code,line,evidence}) => [code,line,evidence]),[['missing-footnote-definition',4,'missing']]);
	assert.equal(result(report,'anchors').status,'partial');
	assert.deepEqual(result(report,'anchors').diagnostics.map(({code,line}) => [code,line]),[
		['invalid-pdf-page',12], ['invalid-pdf-page',13], ['invalid-pdf-page',14], ['unverified-pdf-page',15],
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
	assert.deepEqual(codes(result(rejected,'fixture.check')),['checker-untrusted']);
	assert.ok(rejected.logPath);
});

test('reports checker failures, excessive output, timeouts, and log failure without exposing exceptions', async t => {
	const {root,vault,options,put} = await fixture(t);
	for (const [source,expected] of [
		['export default () => [{severity:"error", code:"bad", file:"../escape.md", message:"Invalid"}];','checker-output'],
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
	const located = invoke('--library',root,'--config-dir','.settings','--checks','fixture.check','--trust-digest',digest(script));
	assert.equal(located.status,1);
	assert.equal(JSON.parse(located.stdout).checks[0].diagnostics[0].message,relative);
	const bad = invoke('--bad');
	assert.equal(bad.status,2);
	assert.equal(JSON.parse(bad.stdout).status,'failed');
});
