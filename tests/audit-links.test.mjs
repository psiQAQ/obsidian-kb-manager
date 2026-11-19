import assert from 'node:assert/strict';
import test from 'node:test';
import {checkIndex,checkLinks} from '../src/kb/audit-links.ts';
import {checkOperations} from '../src/kb/audit-operations.ts';
import {parseMarkdown,candidates,contains,sourceBody} from '../src/kb/audit-markdown.ts';

test('reference links and images use the first normalized definition and retain line numbers',()=>{
	const md='[Text][ A   B ] ![Image][] [Straße][STRASSE]\n\n[a b]: <./first file.md> "title"\n[a B]: ./wrong.md\n[image]: ./image.png\n[straße]: ./unicode.md';
	const parsed=parseMarkdown(md);
	assert.deepEqual(parsed.links.map(l=>l.target),['./first file.md','./image.png','./unicode.md']);
	assert.equal(parsed.links[2].line,1);
	assert.match(parsed.visible,/Text Image Straße/u);
	assert.deepEqual(parseMarkdown('~~~md\n[x]: ./hidden.md\n~~~\n[a][x]').links,[]);
	assert.deepEqual(parseMarkdown('``text ` [a](bogus) ` end``\n<!--\n[a](bad)\n-->\n[ok](real)').links,
		[{label:'ok',target:'real',line:5}]);
});

test('only visible values are candidates; dates and numbers have exact boundaries',()=>{
	const body='[42K][r] ![2026-11-17][img] `77777` https://example.test/55555\n\n[r]: https://example.test/99999 "3.14"\n[img]: ./88888.png\n';
	assert.deepEqual(new Set(candidates(body).map(x=>x.value)),new Set(['42K','2026-11-17']));
	assert.deepEqual(candidates('样本 42 个，另有 500 个。'),[]);
	for(const [claim,source] of [['42K','142K'],['3.14','3.1415'],['2026-11','2026-11-16']])
		assert.equal(contains(source,candidates(claim)[0]),false);
	assert.equal(contains('样本数量为 42K。',candidates('42K')[0]),true);
	const quote='> A sufficiently long direct\n> quotation preserved from the source.';
	assert.equal(contains('A sufficiently long direct quotation preserved from the source.',candidates(quote)[0]),true);
	const evidence=sourceBody('# Imported\n\n> Source: x\n> Collected: 2026-11-17\n\n`99999` [3.14](88888.md)');
	assert.deepEqual(candidates(evidence).map(x=>x.value),['3.14']);
});

const mapping={raw:'raw',wiki:'wiki',notes:'Notes',reports:'reports',clippings:'clip',index:'wiki/index.md',log:'wiki/log.md',templates:'templates',overview:'wiki/overview.md'};
async function run(notes,extras=[],articles=[],strict=true){
	const findings=[],reads=[];
	const location='knowledge-base/A',files=new Set([...Object.keys(notes),...extras]);
	const parsed=(_,note)=>parseMarkdown(note.body);
	const rows=new Map(Object.entries(notes).map(([name,body])=>[name,{metadata:name==='wiki/p.md'?{managed_by:'agent'}:{},body}]));
	const report=(level,code,file)=>findings.push([level,code,file]);
	await checkLinks({location,mapping:strict?mapping:undefined,files,notes:rows,parsed,
		readBody:async file=>{reads.push(file);return '# A B!\nSome text ^ok';},
		report});
	if(strict && rows.has(mapping.index))checkIndex(mapping,parsed(mapping.index,rows.get(mapping.index)),files,
		new Map(articles.map(file=>[file,rows.get(file)])),report);
	const noMaterial=strict ? checkOperations(location,mapping,files,rows,parsed,report) : new Set();
	return {findings,reads,noMaterial};
}

test('scoped links, headings, blocks, duplicate and missing index entries',async()=>{
	const result=await run({
		'wiki/p.md':'[ok](../raw/C%23.md#a-b) [block](../raw/C%23.md#%5Eok) [broken](../raw/C%23.md#ghost) [[knowledge-base/B/raw/C#secret]] [outside](../../B/raw/p.md#hidden) [missing](missing.md) [bad](bad%zz)',
		'wiki/index.md':'[one][] [two](p.md)\n\n[one]: p.md',
		'wiki/other.md':'',
	},['raw/C#.md'],['wiki/p.md','wiki/other.md']);
	assert.deepEqual(result.reads,['raw/C#.md']);
	assert.deepEqual(result.findings.map(f=>f[1]).sort(),['broken-fragment','broken-link','broken-link','cross-kb-link','cross-kb-link','index-duplicate','index-missing'].sort());
	assert.deepEqual(result.findings.find(f=>f[1]==='index-missing'),['error','index-missing','wiki/other.md']);
});

test('index entries retain scope and duplicate findings for missing files, and check Wikilinks independently',async()=>{
	const {findings,reads}=await run({'wiki/index.md':'[out](../../B/raw/no.md) [again](../../B/raw/no.md) [[knowledge-base/A/wiki/p]]','wiki/p.md':''},[],['wiki/p.md']);
	assert.equal(findings.filter(f=>f[1]==='index-scope').length,2);
	assert.equal(findings.filter(f=>f[1]==='index-duplicate').length,1);
	assert.ok(findings.some(f=>f[1]==='index-missing' && f[2]==='wiki/p.md'));
	assert.deepEqual(reads,[]);
});

test('intentional human links are reviewable; custom templates have no LLM Wiki rules',async()=>{
	const result=await run({'Notes/rough.md':'[[pending]] [[photo]]','wiki/p.md':'[[photo]]'},['raw/photo.md']);
	assert.ok(result.findings.some(([level,code])=>level==='review'&&code==='broken-link'));
	assert.ok(result.findings.some(([level,code])=>level==='error'&&code==='ambiguous-wikilink'));
	const custom=await run({'wiki/p.md':'[[photo]]'},['raw/photo.md'],['wiki/p.md'],false);
	assert.deepEqual(custom.findings,[['review','human-wikilink-scope','wiki/p.md']]);
});

test('No material accepts the Raw line in a real ingest record, including reference definitions',async()=>{
	const entry='## [2026-11-17] ingest | duplicate\n- Disposition: No material\n- Raw: [input][]\n';
	const result=await run({'wiki/log.md':'```md\n'+entry+'```\n'+entry+'\n[input]: ../clip/a%20b.md\n'},['clip/a b.md']);
	assert.deepEqual([...result.noMaterial],['clip/a b.md']);assert.deepEqual(result.findings,[]);
	const fake=await run({'wiki/log.md':'```md\n'+entry+'```\n[input]: ../clip/a%20b.md'},['clip/a b.md']);
	assert.equal(fake.noMaterial.size,0);
});
