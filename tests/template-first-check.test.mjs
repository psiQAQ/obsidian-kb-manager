import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {generalChecks, portabilityCheck, runDiagnostics} from '../src/diagnostics/index.ts';
import {headOid} from '../src/git/repository.ts';
import {prose} from '../src/kb/audit-markdown.ts';
import {defaults, discover} from '../src/kb/catalog.ts';
import {insertTemplate} from '../src/kb/insert.ts';
import {readVaultRegistry} from '../src/registry/desktop.ts';
import {templateCatalog} from '../scripts/template-catalog.mjs';
import {vaultDisk} from './fixtures/vault-disk.mjs';

const {packs} = templateCatalog(fileURLToPath(new URL('../assets/templates/', import.meta.url)));
// Provide the catalogue normally embedded by esbuild when running this fixture in Node.
globalThis.KB_TEMPLATE_PACKS = packs;
const {createLibrary, previewCreate} = await import('../src/kb/create.ts');
const {builtinSource, packText} = await import('../src/kb/template-pack.ts');
const checks = [...generalChecks, portabilityCheck].map(check => check.id);
const categoryTemplate = 'Templates/分类入口模板.md';

// The freshly created vault supplies the complete file index for this fixture.
// Support exact vault paths, source-relative paths and unique short names.
// Diagnostics supplies Markdown occurrences and checks named Base views itself.
async function fixtureResolver(vault) {
	const entries = await fs.readdir(vault, {recursive:true, withFileTypes:true});
	const files = new Set(entries.filter(entry => entry.isFile())
		.map(entry => path.relative(vault, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
		.filter(file => file.split('/').every(part => !part.startsWith('.'))));
	const {basename, dirname, join} = path.posix;
	const exact = file => files.has(file) ? file : files.has(file + '.md') ? file + '.md' : undefined;
	return async ({source, target, fragment, canvasPath}) => {
		let file;
		if (!target) file = source;
		else if (canvasPath) file = target;
		else {
			const relative = join(dirname(source), target);
			file = /^\.\.?\//u.test(target) ? exact(relative) : exact(target) ?? exact(relative);
		}
		if (!file && !canvasPath && !target.includes('/')) {
			const matches = [...files].filter(candidate => basename(candidate) === target || basename(candidate) === target + '.md');
			if (matches.length > 1) return {status:'unknown',reason:'The fixture cannot choose among ambiguous short names.'};
			file = matches[0];
		}
		if (!file || !files.has(file)) return {status:'missing'};
		if (!fragment || !file.endsWith('.md')) return {status:'resolved',path:file};
		const text = prose(await fs.readFile(path.join(vault,file),'utf8'));
		const headings = [...text.matchAll(/^#{1,6} +(.+?) *#* *$/gmu)].map(match => match[1]);
		const blocks = [...text.matchAll(/(?:^|\s)\^([\w-]+) *$/gmu)].map(match => match[1]);
		const found = fragment.startsWith('#^') ? blocks.includes(fragment.slice(2)) : headings.includes(fragment.slice(1));
		return {status:'resolved',path:file,anchor: found ? 'resolved' : 'missing'};
	};
}

test('first general checks find no errors in newly created libraries for all 18 built-in templates', async t => {
	const scratch = path.resolve('.tmp');
	await fs.mkdir(scratch,{recursive:true});
	const directory = await fs.mkdtemp(path.join(scratch,'template-first-check-'));
	t.after(async () => {
		assert.equal(path.dirname(path.resolve(directory)),scratch);
		await fs.rm(directory,{recursive:true, force:true});
	});
	const globalConfig = path.join(directory,'global.gitconfig');
	await fs.writeFile(globalConfig,'[user]\n name = Template Test\n email = template@example.invalid\n');
	const gitEnvironment = {GIT_CONFIG_GLOBAL:globalConfig, GIT_CONFIG_NOSYSTEM:'1', GIT_AUTHOR_NAME:undefined,
		GIT_AUTHOR_EMAIL:undefined, GIT_COMMITTER_NAME:undefined, GIT_COMMITTER_EMAIL:undefined};
	for (const [key,value] of Object.entries(gitEnvironment)) {
		const previous = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	assert.equal(Object.keys(packs).length,18);
	for (const [id,{descriptor}] of Object.entries(packs)) {
		await t.test(id, async () => {
			const vaultRoot = path.join(directory,id);
			const configDir = '.test-settings';
			await fs.mkdir(path.join(vaultRoot,configDir),{recursive:true});
			const disk = vaultDisk(vaultRoot,configDir);
			const input = {parent:'',name:'新建库 ' + id,displayName:descriptor.name,description:'通用首检',source:builtinSource(id)};
			const skeleton = packText(id === 'kepano' ? 'kepano' : 'llm-wiki');
			const preview = await previewCreate(disk,defaults,input,skeleton);
			const {path:libraryRoot,location,head} = await createLibrary(disk,defaults,preview,skeleton);
			assert.match(head,/^[a-f0-9]{40}$/u);
			const tracked=execFileSync('git',['ls-files','-z'],{cwd:libraryRoot,encoding:'utf8'}).split('\0');
			for(const required of ['README.md','checks/kb-check.cjs',...checks.map(check=>'checks/common/'+check+'.mjs')])
				assert.ok(tracked.includes(required),required);
			assert.match(await fs.readFile(path.join(libraryRoot,'README.md'),'utf8'),/checks\/kb-check\.cjs/u);
			if(id==='coursework'){
				const detached=path.join(directory,'detached');
				await fs.cp(libraryRoot,detached,{recursive:true,filter:source=>path.basename(source)!=='.git'});
				const cli=spawnSync(process.execPath,['./checks/kb-check.cjs','--library','.','--checks','all'],{
					cwd:detached,encoding:'utf8',maxBuffer:8*1024*1024});
				const data=cli.stdout;
				assert.ok(cli.status===0 || cli.status===1,cli.stderr || data);
				const offline=JSON.parse(data);
				assert.equal(offline.environment,'offline');
				assert.ok(offline.logPath,offline.logError);
				assert.ok(offline.checks.some(check=>check.id==='workflow'));
				assert.ok(offline.checks.every(check=>check.status!=='failed'),data);
			}
			const {paths:registeredPaths} = await readVaultRegistry(disk);
			assert.deepEqual(registeredPaths,[location]);
			const library = (await discover(disk,defaults)).find(lib => lib.location === location);
			assert.equal(library?.git,'local');
			assert.equal(library.duplicate,false);
			const run = async () => runDiagnostics({libraryRoot,vaultRoot,configDir,selected:checks,
				registered:registeredPaths.includes(location),registeredPaths,duplicate:library.duplicate,
				resolveLink:await fixtureResolver(vaultRoot)});
			const report = await run();
			assert.equal(report.library.id,library.identity.id);
			assert.equal(report.library.template?.id,id);
			assert.deepEqual(report.checks.map(check => check.id),checks);
			assert.deepEqual(report.checks.filter(check => check.status === 'failed'),[]);
			assert.deepEqual(report.checks.flatMap(check => check.diagnostics.filter(row => row.severity === 'error')),[]);
			const byId = new Map(report.checks.map(check => [check.id,check]));
			assert.equal(byId.get('manifest').status,'passed');
			for (const check of ['properties','links','bases','bindings','portability']) {
				assert.ok(byId.get(check).coverage.checked > 0,`${id}: ${check} had no checked items`);
			}
			const links = byId.get('links');
			assert.equal(links.coverage.unknown,0,JSON.stringify(links.diagnostics));
			assert.ok(report.logPath,report.logError);
			assert.equal(await headOid(libraryRoot),head);
			if (id !== 'llm-wiki') return;

			assert.ok(links.diagnostics.some(row => row.file === categoryTemplate &&
				row.code === 'template-link-deferred' && row.severity === 'info'));
			const templatePath = path.join(libraryRoot,categoryTemplate);
			const original = await fs.readFile(templatePath,'utf8');
			const inserted = insertTemplate('',original,0,'实际分类',() => '2026-11-21');
			assert.match(inserted.text,/!\[\[\{\{base_path\}\}\]\]/u);
			const page = 'wiki/实际分类.md';
			const writePage = target => fs.writeFile(path.join(libraryRoot,page),inserted.text.replace('{{base_path}}',target));
			await writePage(`${location}/knowledge.base`);
			const filled = (await run()).checks.find(check => check.id === 'links');
			assert.deepEqual(filled.diagnostics.filter(row => row.file === page),[]);
			assert.equal(filled.coverage.checked,links.coverage.checked + 1);
			const wrongBase = `${location}/wiki/bases/路径填错.base`;
			await writePage(wrongBase);
			await fs.appendFile(templatePath,'\n![[../缺失附件.png]]\n');
			const changed = (await run()).checks.find(check => check.id === 'links').diagnostics;
			assert.deepEqual(changed.filter(row => row.severity === 'error').map(({file,code}) => [file,code]),[
				[categoryTemplate,'missing-attachment'],[page,'missing-attachment'],
			]);
			assert.ok(changed.some(row => row.file === page && row.evidence === wrongBase));
		});
	}
});
