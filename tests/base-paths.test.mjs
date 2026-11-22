import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {bundledCommonDigest} from '../src/diagnostics/bundled-common.ts';
import {listDiagnosticHistory,runDiagnostics} from '../src/diagnostics/index.ts';
import {scanBasePathFilters,scanBasePaths} from '../src/kb/base-paths.ts';
import {checkKitFiles} from '../src/kb/check-kit.ts';

test('scan Base global and view filters with source spans across YAML scalar styles', () => {
	const quoted = 'this.file.path.startsWith("Old/Notes/") && !file.inFolder("Old/Example")';
	const text = [
		'filters:', '  and:', `    - ${JSON.stringify(quoted)} # keep`,
		"    - 'file.inFolder(''Old/It\\''s'')'",
		'    - >-', '      file.inFolder("Old/Folded") &&', '      file.path.startsWith(this.file.folder + "/")',
		`    - 'note.file.inFolder("Not A File Object") && /file.inFolder("Regex")/.matches(note.text)'`,
		`formulas: {label: 'file.inFolder("Formula")'}`,
		'views:', '  - type: table', '    name: Recent',
		`    filters: {not: ['note.text == "file.inFolder(ignored)"', 'file.inFolder("Old/View")']}`,
	].join('\r\n');
	const references = scanBasePaths(text,'base');
	assert.deepEqual(references.map(({receiver,kind,field,line,column,argument}) => [receiver,kind,field,line,column,argument?.value]),[
		['this.file','startsWith','filters.and[0]',3,8,'Old/Notes/'],
		['file','inFolder','filters.and[0]',3,54,'Old/Example'],
		['file','inFolder','filters.and[1]',4,8,"Old/It's"],
		['file','inFolder','filters.and[2]',6,7,'Old/Folded'],
		['file','startsWith','filters.and[2]',7,7,undefined],
		['file','inFolder','views[0].filters.not[1]',13,63,'Old/View'],
	]);
	const edits = references.flatMap(({argument}) => argument?.replace ? [argument] : []);
	let proposed = text;
	for (const {start,end,value,replace} of edits.reverse()) {
		assert.ok(text.slice(start,end).includes('Old/'));
		proposed = proposed.slice(0,start) + replace(value.replace('Old/','Archive/')) + proposed.slice(end);
	}
	assert.deepEqual(scanBasePaths(proposed,'base').map(({argument}) => argument?.value),[
		'Archive/Notes/','Archive/Example',"Archive/It's",'Archive/Folded',undefined,'Archive/View',
	]);
	assert.equal(proposed.replaceAll('Archive/','Old/'),text);
});

test('scan inline fences after frontmatter and keep anchored expressions read-only', () => {
	const markdown = [
		'---','example: |','  ```base','  filters: file.inFolder("Skipped Header")','  ```','---',
		'````markdown','```base','filters: file.inFolder("Skipped Fence")','```','````',
		'~~~base','filters:','  or: &shared','    - file.inFolder("Anchored")','    - &condition file.inFolder("Aliased")',
		'    - *condition','views:','  - type: table','    name: Example','    filters: file.folder == "Manual"','~~~',
		'```base','filters: file.inFolder("Editable")','```',
	].join('\r\n');
	const refs = scanBasePaths(markdown,'md');
	assert.deepEqual(refs.map(({argument,line}) => [argument.value,line,!!argument.replace]),[
		['Anchored',15,false],['Aliased',16,false],['Aliased',17,false],['Editable',24,true],
	]);
	const {argument:{start,end}} = refs[3];
	assert.equal(markdown.slice(start,end),'"Editable"');
	assert.ok(scanBasePathFilters(markdown,'md').some(({expression,references}) => expression.includes('Manual') && !references.length));
	assert.deepEqual(scanBasePaths('---\n```base\nfilters: file.inFolder("Ignored")\n```','md'),[]);
});

test('only visible inline Base fences yield path references', () => {
	const block = '```base\nfilters: file.inFolder("Active")\n```\n';
	const text = '\uFEFF' + block + '\n<!--\n' + block + '-->\n\n%%\n' + block + '%%\n\n`%%`\n' + block;
	assert.deepEqual(scanBasePaths(text,'md').map(({line}) => line),[2,19]);
});

test('Bases path findings match across legacy, installed common rule, and standalone runner', async t => {
	const workspace = path.resolve('.tmp');
	await mkdir(workspace,{recursive:true});
	const fixture = await mkdtemp(path.join(workspace,'base-paths-'));
	t.after(async () => {
		assert.equal(path.dirname(path.resolve(fixture)),workspace);
		await rm(fixture,{recursive:true,force:true});
	});
	const vault = path.join(fixture,'vault');
	const root = path.join(vault,'Library');
	const configDir = 'Test Settings';
	await Promise.all([`vault/${configDir}`,'vault/Library/Notes','vault/Shared/Records','Outside'].map(dir => mkdir(path.join(fixture,dir),{recursive:true})));
	await symlink(path.join(fixture,'Outside'),path.join(vault,'Linked'),process.platform === 'win32' ? 'junction' : 'dir');
	await writeFile(path.join(root,'Notes','one.md'),'# Note\n');
	await writeFile(path.join(root,'index.base'),[
		'filters:', '  and:',
		'    - file.inFolder("Library/Notes")',
		'    - this.file.path.startsWith("Shared/Records/")',
		'    - file.inFolder("Library/Missing")',
		'    - this.file.inFolder("../Records")',
		'    - file.path.startsWith("Library/Notes/one")',
		'    - file.path.startsWith("Absent file prefix")',
		'    - file.inFolder(this.file.folder)',
		'    - file.inFolder("Linked")',
		'    - file.inFolder("{{kb_root}}/Notes")',
		'views:', '  - name: Recent', '    type: table',
		'    filters: this.file.path.startsWith("Shared/Missing/")',
		'  - name: Protected', '    type: table',
		`    filters: file.inFolder("${configDir}")`,
	].join('\n'));
	const note = path.join(root,'index.md');
	await writeFile(note,'---\r\nx: yes\r\n---\r\n\r\n```base\r\nfilters: file.path.startsWith("./Notes/")\r\n```\r\n');
	const baseBefore = await readFile(path.join(root,'index.base'),'utf8');
	const noteBefore = await readFile(note,'utf8');
	const options = {libraryRoot:root,vaultRoot:vault,configDir,selected:['bases']};
	const findings = ({checks:[check]}) => check.diagnostics.map(({code,severity,file,line,column,field,evidence}) => [code,severity,file,line,column,field,evidence]);
	const expected = [
		['base-path-missing-folder','info','index.base',5,7,'filters.and[2]','"Library/Missing"'],
		['base-path-relative','warning','index.base',6,7,'filters.and[3]','"../Records"'],
		['base-path-unverified','info','index.base',9,7,'filters.and[6]','file.inFolder(this.file.folder)'],
		['base-path-unverified','info','index.base',10,7,'filters.and[7]','"Linked"'],
		['base-path-unverified','info','index.base',11,7,'filters.and[8]','"{{kb_root}}/Notes"'],
		['base-path-missing-folder','info','index.base',15,14,'views[0].filters','"Shared/Missing/"'],
		['base-path-unverified','info','index.base',18,14,'views[1].filters',JSON.stringify(configDir)],
		['base-path-relative','warning','index.md',6,10,'filters','"./Notes/"'],
	];
	const legacy = await runDiagnostics(options);
	assert.equal(legacy.checks[0].rule.engine,'legacy');
	assert.deepEqual(findings(legacy),expected);
	const noVault = await runDiagnostics({libraryRoot:root,selected:['bases']});
	assert.ok(findings(noVault).some(([code,,,,,,evidence]) => code === 'base-path-unverified' && evidence === '"Library/Notes"'));
	assert.ok(!findings(noVault).some(([code]) => code === 'base-path-missing-folder'));
	const filename = 'checks/common/bases.mjs';
	for (const [file,content] of Object.entries(checkKitFiles()).filter(([file]) => [filename,'checks/kb-check.cjs'].includes(file))) {
		await mkdir(path.dirname(path.join(root,file)),{recursive:true});
		await writeFile(path.join(root,file),content);
	}
	const installed = await runDiagnostics(options);
	assert.equal(installed.checks[0].rule.engine,'bundled');
	assert.equal(bundledCommonDigest({id:'bases',name:'Bases',path:filename,digest:'9a301508ebad2ce27efee92063786709b1a7f30a0d9165cdd6da0ae088e53104'}),installed.checks[0].rule.digest);
	assert.deepEqual(findings(installed),expected);
	const offline = JSON.parse(execFileSync(process.execPath,[path.join(root,'checks/kb-check.cjs'),'--library',root,'--config-dir',configDir,'--checks','bases'],{encoding:'utf8'}));
	assert.equal(offline.environment,'offline');
	assert.deepEqual(findings(offline),expected);
	const saved = (await listDiagnosticHistory(root)).find(({runId}) => runId === offline.runId);
	assert.ok(saved);
	assert.deepEqual(findings(saved),expected);
	assert.equal(await readFile(path.join(root,'index.base'),'utf8'),baseBefore);
	assert.equal(await readFile(note,'utf8'),noteBefore);
});
