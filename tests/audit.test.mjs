import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { VaultDisk } from '../src/fs/vault.ts';
import { auditLibrary } from '../src/kb/audit.ts';
import { inspect } from '../src/kb/catalog.ts';

const location = 'knowledge-base/资料';
const template = path.resolve('assets/llm-wiki');
async function setup(t) {
	await fs.mkdir('.tmp',{recursive:true});
	const vault = await fs.mkdtemp(path.resolve('.tmp/audit-'));
	t.after(() => fs.rm(vault,{recursive:true,force:true}));
	const root = path.join(vault,location);
	await fs.cp(template,root,{recursive:true});
	const put = async (file,text) => {
		const target = path.join(root,file);
		await fs.mkdir(path.dirname(target),{recursive:true});
		await fs.writeFile(target,text);
	};
	// Match an instantiated Base after the template bindings have been rendered.
	await put('knowledge.base','views: [{type: table}]\n');
	const disk = new VaultDisk(vault,'.settings');
	const run = async () => auditLibrary(disk,await inspect(disk,location));
	return {root,vault,put,run,disk};
}
function page(type,sources,body='',extra='') {
	return ['---','managed_by: agent','type: '+type,'categories: []','tags: []','aliases: []',
		'created: 2024-02-28','updated: 2024-03-01','sources: '+JSON.stringify(sources),extra,'---',body].join('\n');
}
function triples(findings) { return findings.map(f=>[f.level,f.code,f.file].join('|')).sort(); }

// During a migration, developers can point these at the original Python checker
// and its existing environment. Both implementations read the same test vault.
function compareReference(fixture,findings) {
	const {KB_AUDIT_REFERENCE_SCRIPTS:scripts,KB_AUDIT_REFERENCE_PYTHON:python}=process.env;
	if (!scripts && !python) return;
	assert.ok(scripts && python,'Provide both reference checker paths');
	const script = [
		'import json,sys','from pathlib import Path','sys.path.insert(0,sys.argv[1])',
		'from check_kb import inspect','root,vault=map(Path,sys.argv[2:])',
		'print(json.dumps(["|".join((f.level,f.code,f.path.relative_to(root).as_posix())) for f in inspect(root,vault)]))',
	].join('\n');
	const reference = execFileSync(python,['-B','-I','-c',script,scripts,fixture.root,fixture.vault],{encoding:'utf8'});
	assert.deepEqual(triples(findings),JSON.parse(reference).sort());
}

test('rendered LLM Wiki passes the original read-only audit',async t=>{
	const fixture=await setup(t);
	const findings=await fixture.run();
	assert.deepEqual(findings,[]);
	compareReference(fixture,findings);
});

test('sources, archival, metadata, Base and ingestion diagnostics match the legacy checker',async t=>{
	const fixture=await setup(t);
	const {put,root}=fixture;
	await put('Notes/草稿.md','人工笔记正文。');
	await put('raw/快照.md','---\nsnapshot_source_note: ../Notes/草稿.md\nsnapshot_source_mtime_ns: "1"\n---\n测量 42K。');
	await put('raw/待处理.md','already on disk');
	await put('raw/assets/img.bin',Buffer.from([255,0,128]));
	await put('Clippings/跳过.md','content');
	await put('raw/pdf.pdf',Buffer.from([0,255,0]));
	await put('wiki/page.md',page('concept',['../raw/快照.md','../raw/pdf.pdf','../raw/缺失.md','../Notes/草稿.md','https://invalid.test'],'测量 42K，转述 57K。'));
	await put('wiki/archive.md',page('archive',['page.md','index.md'],'','archived: 2024-02-28'));
	await put('wiki/empty.md',page('concept',[]));
	await put('wiki/index.md','[页面](page.md)\n[归档](archive.md)\n');
	await put('wiki/log.md','## [2024-02-29] ingest | duplicate\n- Raw: [跳过](../Clippings/跳过.md)\n- Disposition: No material\n');
	await put('wiki/bad.md','---\ntype: concept\ntype: entity\n---\n');
	await put('reports/bad.base','views: [invalid]\n');
	await put('main.base','filters: __WIKI_PATH__\n');
	await put('templates/note.base','filters: __WIKI_PATH__\n');
	await put('raw/bad.base','views: [invalid]\n');
	const files=['Notes/草稿.md','raw/快照.md','wiki/page.md','wiki/log.md','knowledge.base'];
	const bytes=()=>Promise.all(files.map(f=>fs.readFile(path.join(root,f))));
	const before=await bytes();
	const findings=await fixture.run();
	const codes=new Set(findings.map(f=>f.code));
	for(const code of ['source-path','source-scope','source-missing','sources-missing','snapshot-source-changed',
		'archive-source','archive-stale','empty-overview','human-properties','evidence-unverified','evidence-candidate',
		'index-missing','unprocessed-raw','invalid-base','base-binding-missing','invalid-metadata']) assert.ok(codes.has(code),code);
	assert.deepEqual(findings.filter(f=>f.code==='unprocessed-raw').map(f=>f.file).sort(),['raw/bad.base','raw/待处理.md'].sort());
	assert.equal(findings.filter(f=>f.code==='evidence-candidate').length,1);
	assert.deepEqual(await bytes(),before);
	compareReference(fixture,findings);
});

test('mapped source roots, metadata and required paths are validated independently',async t=>{
	const fixture=await setup(t);
	const {put,root}=fixture;
	const config=await fs.readFile(path.join(root,'kb.toml'),'utf8');
	await put('kb.toml',config.replace(/^clippings = .*\r?\n/mu,''));
	await put('Clippings/protected.md','---\nbroken: [\n');
	await put('Notes/bad.md','---\ntags: not-a-list\ncreated: "2025-02-29"\nmanaged_by: unknown\n---');
	await put('Notes/invalid-date.md','---\ncreated: 2025-02-29\n---');
	await put('wiki/date.md','---\nmanaged_by: agent\ntype: concept\nsources: []\n---');
	await fs.rm(path.join(root,'reports'),{recursive:true});
	await fs.unlink(path.join(root,'wiki','index.md'));
	const findings=await fixture.run();
	for (const code of ['clippings-unmapped','property-type','date-format','date-missing','managed-by','directory-missing','special-file-missing'])
		assert.ok(findings.some(f=>f.code===code),code);
	assert.ok(!findings.some(f=>f.file==='Clippings/protected.md'));
	compareReference(fixture,findings);
});

test('custom templates get generic links and Base structure while nested libraries remain outside the scan',async t=>{
	const {put,disk}=await setup(t);
	await put('template-copy/kb.toml','');
	await put('template-copy/notes.md','---\nbad yaml: [\n');
	await put('entry.md','[待写](missing.md)');
	await put('custom.base','views: [1]');
	const lib=await inspect(disk,location);
	const generic=await auditLibrary(disk,{...lib,identity:{template:{id:'custom',version:'1'}}});
	assert.deepEqual(triples(generic),['error|invalid-base|custom.base','review|broken-link|entry.md','review|nested-library|template-copy'].sort());
	const adopted=await auditLibrary(disk,{...lib,identity:{template:{id:'unknown',version:'unknown'}}});
	assert.ok(adopted.some(f=>f.code==='human-location' && f.file==='entry.md'));
});
