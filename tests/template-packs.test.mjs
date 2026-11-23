import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { parse } from 'yaml';
import { templateCatalog } from '../scripts/template-catalog.mjs';
import { declaration } from '../src/kb/template-declaration.ts';
import llmWiki from '../assets/templates/ai-workflows/llm-wiki/checks/analysis-evidence.mjs';
import aiWorklog from '../assets/templates/ai-workflows/ai-worklog/checks/workflow.mjs';
import kepano from '../assets/templates/collections/kepano/checks/category-links.mjs';
import mediaTracker from '../assets/templates/collections/media-tracker/checks/workflow.mjs';
import garden from '../assets/templates/engineering/knowledge-garden/checks/workflow.mjs';
import {collectCheckLinkEvidence} from '../src/diagnostics/check-links.ts';
import radar from '../assets/templates/engineering/technology-radar/checks/workflow.mjs';
import coursework from '../assets/templates/learning/coursework/checks/workflow.mjs';
import exam from '../assets/templates/learning/exam-practice/checks/workflow.mjs';
import gtd from '../assets/templates/projects/gtd/checks/workflow.mjs';
import projectReview from '../assets/templates/projects/project-review/checks/workflow.mjs';
import domainReading from '../assets/templates/reading/domain-reading/checks/workflow.mjs';
import zettelkasten from '../assets/templates/reading/zettelkasten/checks/workflow.mjs';
import evidence from '../assets/templates/research/research-evidence/checks/workflow.mjs';
import project from '../assets/templates/research/research-project/checks/workflow.mjs';
import firstWeek from '../assets/templates/starter/minimal-first-week/checks/workflow.mjs';
import journal from '../assets/templates/starter/minimal-journal/checks/workflow.mjs';
import manuscript from '../assets/templates/writing/manuscript/checks/workflow.mjs';
import worldbuilding from '../assets/templates/writing/worldbuilding/checks/workflow.mjs';

const directory = new URL('../assets/templates/', import.meta.url);
const { packs, digests } = templateCatalog(fileURLToPath(directory));
globalThis.KB_TEMPLATE_PACKS = packs;
const { renderPack } = await import('../src/kb/template-pack.ts');
const { builtinTemplate, kepanoTemplate } = await import('../src/kb/template-core.ts');
const root = 'Libraries/测试库 + 样例';
const other = 'Libraries/他库';
const decoder = new TextDecoder();
const checkers = {
	'llm-wiki':llmWiki, 'ai-worklog':aiWorklog, kepano, 'media-tracker':mediaTracker, 'knowledge-garden':garden,
	'technology-radar':radar, coursework, 'exam-practice':exam, gtd, 'project-review':projectReview, 'domain-reading':domainReading,
	zettelkasten, 'research-evidence':evidence, 'research-project':project, 'minimal-first-week':firstWeek, 'minimal-journal':journal, manuscript, worldbuilding,
};

function instance(id, destination = root) {
	const template = id === 'kepano' ? kepanoTemplate(packs.kepano.text, destination)
		: renderPack(id, { destination, displayName:'测试库', description:'实例验证' });
	return Object.fromEntries(template.files
		.map(({ name, bytes }) => [name, decoder.decode(bytes)]));
}

function notes(text) {
	return Object.entries(text).filter(([path]) => path.endsWith('.md')).map(([path, source]) => {
		const header = /^---\n([\s\S]*?)^---(?:\n|$)/mu.exec(source);
		return header?.index === 0
			? { path, properties:parse(header[1]) ?? {}, body:source.slice(header[0].length) }
			: { path, properties:{}, body:source };
	});
}

function linkInventory(text, noteList) {
	return {files:new Set(Object.keys(text)), excluded:new Set(), unreadableDirectories:new Set(),
		notes:noteList.map(note => ({...note, lineOffset:0}))};
}

function fixtureTarget(text, {source, target}) {
	const candidate = /^\.\.?\//u.test(target) ? posix.join(posix.dirname(source), target) : target;
	const library = [root, other].find(value => candidate.startsWith(value + '/'));
	if (!library) return {status:'missing'};
	const relative = candidate.slice(library.length + 1);
	const file = relative in text ? relative : relative + '.md';
	return file in text ? {status:'resolved', path:library + '/' + file} : {status:'missing'};
}

const negative = {
	'ai-worklog': ['Decisions/先试云端索引.md', { supersedes:`[[${root}/Decisions/采用本地索引]]` }, 'decision-cycle'],
	'llm-wiki': ['wiki/示例分析.md', { type:'analysis', managed_by:'agent' }, 'analysis-evidence-missing'],
	'kepano': ['References/The Machine Stops.md', { categories:[`[[${other}/Categories/Books]]`] }, 'category-link-outside-library'],
	'media-tracker': ['Media/远岸电台.md', { progress:7 }, 'invalid-media-progress'],
	'knowledge-garden': ['Guides/如何记录检索失败.md', { related:[`[[${root}/Drafts/内部提纲]]`] }, 'sharing-private-reference'],
	'technology-radar': ['Radar/本地全文索引.md', { adoption_reason:'' }, 'radar-adoption-unsupported'],
	'coursework': ['Courses/实验入门/Assignments/图表作业.md', { due:'2026-02-30' }, 'assignment-due-invalid'],
	'exam-practice': ['Practice/读时间复杂度.md', { attempts:[] }, 'retry-record-missing'],
	'gtd': ['Actions/等待确认取样时间.md', { follow_up:'' }, 'waiting-follow-up-missing'],
	'project-review': ['Archives/公开说明.md', {}, 'archived-project-open-task', '\n- [ ] 漏做的行动'],
	'domain-reading': ['Terms/对照条件.md', { review:true, tags:['flashcards/example-instance'] }, 'review-card-incomplete', '问题\n?\n'],
	'zettelkasten': ['Permanent/理解需要检验.md', { literature:[] }, 'literature-card-missing'],
	'research-evidence': ['Evidence/重复测量.md', { sources:[`[[${other}/Sources/读数报告]]`] }, 'evidence-source-invalid'],
	'research-project': ['Projects/同一份样品的重复测量.md', { evidence:[`[[${other}/Records/重复测量观察]]`] }, 'research-evidence-missing'],
	'minimal-first-week': ['Journal/2026-09-07.md', { date:'2026-09-08' }, 'journal-date-mismatch'],
	'minimal-journal': ['Notes/2026/图书馆札记.md', { date:'2025-09-07' }, 'archive-year-mismatch'],
	'manuscript': ['Manuscript/Chapters/02-回声.md', { chapter:1 }, 'chapter-order-duplicate'],
	'worldbuilding': ['Events/驿站换班.md', { end:'2040-04-01' }, 'event-date-order'],
};

test('built-in catalogue has two independent packs per primary purpose and fixed source revisions', () => {
	assert.equal(Object.keys(packs).length, 18);
	assert.ok(digests.includes('2d3b01e0c37a95558ba2c785a3370febf7e990fad02d130169c65bea0a00bb9f'), 'knowledge-garden v1 stays trusted');
	assert.ok(digests.includes('0c99583d7a3ce38b741ed3981ad808e77af7da3ad9bff6300461e3a56f448601'), 'coursework v1 stays trusted');
	assert.ok(digests.includes('9dafdf6d9f9c35aee095e8671fb6abd123fc8d2275781e25c3b363e828492e13'), 'coursework v2/v3 stay trusted');
	assert.ok(digests.includes('f3171fca91b4a58833a4b4246ce25ce8f34999ce4ca90e43c89456470e6cd4e9'), 'coursework v4 before checked items stays trusted');
	assert.ok(digests.includes('811fe153c69dd71d692f3f3b2ba0d285cc8f56984138832b385109b471a95f20'), 'LLM Wiki v6 stays trusted');
	assert.ok(digests.includes('6bc3cc10b5e931db171727b903ad6ce0d54ca0fb65f0373e995b6e3400ab22cf'), 'Kepano v5 stays trusted');
	const purposes = new Map();
	const dependencies = new Set();
	for (const { descriptor, text } of Object.values(packs)) {
		purposes.set(descriptor.purpose, (purposes.get(descriptor.purpose) ?? 0) + 1);
		for (const dependency of descriptor.dependencies ?? []) dependencies.add(dependency);
		assert.ok(text[descriptor.entry], descriptor.id);
		for (const check of descriptor.checks ?? [])
			assert.ok(digests.includes(createHash('sha256').update(text[check.path]).digest('hex')), check.path);
		for (const source of descriptor.sources) assert.match(source.commit, /^[a-f0-9]{40}$/u);
		assert.ok([...Object.keys(text), ...Object.keys(packs[descriptor.id].binary)].every(path => path.split('/').every(part =>
			!part.startsWith('.') || ['.gitignore', '.gitattributes', '.gitkeep'].includes(part))));
	}
	assert.equal(purposes.size, 9);
	for (const count of purposes.values()) assert.equal(count, 2);
	assert.deepEqual(Array.from(dependencies).sort(), ['dataview','obsidian-meta-bind-plugin','obsidian-spaced-repetition','obsidian-tasks-plugin','quickadd','templater-obsidian']);
});

test('the installed declarations exclude only uninstantiated template sources', () => {
	const checks=['links','anchors','portability'];
	for(const [id,{descriptor,text,binary,folders}] of Object.entries(packs)){
		const files=Object.keys(text);
		const markdown=files.filter(path=>path.startsWith('Templates/') && path.endsWith('.md')).sort();
		const rules=descriptor.diagnosticExclusions;
		const mixed=id==='llm-wiki' || id==='kepano';
		const expected=[mixed?{checks,files:markdown}:{checks,folders:['Templates']}];
		if(id==='llm-wiki')expected.push({checks:['bases'],files:['Templates/Bases/分类专用模板.base']});
		assert.deepEqual(rules,expected,id);
		for(const rule of rules){
			for(const file of rule.files??[])assert.ok(file in text,`${id}: ${file}`);
			for(const folder of rule.folders??[]){
				assert.ok(folders.includes(folder),`${id}: ${folder}`);
				assert.ok([...files,...Object.keys(binary)].filter(path=>path.startsWith(folder+'/')).every(path=>markdown.includes(path)),id);
			}
		}
		const variables={destination:root,displayName:'测试库',description:'实例验证'};
		const installed=id==='llm-wiki'?builtinTemplate(text,variables):id==='kepano'?kepanoTemplate(text,root):renderPack(id,variables);
		const local=installed.files.find(file=>file.name==='kb-template.json');
		assert.deepEqual(declaration(decoder.decode(local.bytes)).diagnosticExclusions,rules,id);
	}
});

for (const [id, pack] of Object.entries(packs)) {
	test(`${id} has usable starter links and distinct passing and failing check inputs`, async () => {
		const { descriptor } = pack;
		const legacy = ['llm-wiki', 'kepano'].includes(id);
		const text = instance(id);
		const second = instance(id, other);
		for (const [location, batch] of [[root, text], [other, second]]) {
			const inventory = linkInventory(batch, notes(batch));
			const links = await collectCheckLinkEvidence({}, inventory, '.', location);
			for (const {path} of inventory.notes) {
				for (const {target, status, path:resolved} of links[path].references) {
					if (!/^\.\.?\//u.test(target)) continue;
					assert.equal(status, 'resolved', `${id}: ${location}/${path} → ${target}`);
					assert.ok(resolved.startsWith(location + '/'), `${id}: ${path} → ${resolved}`);
				}
			}
		}
		if (!legacy) {
			assert.ok(text['LICENSE.upstream.txt']);
			assert.ok(text['Examples/Checks.md']);
			assert.ok(Object.keys(text).some(path => path.startsWith('Templates/') && path.endsWith('.md')));
			for (const [file, source] of Object.entries(text)) {
				if (!file.endsWith('.md')) continue;
				assert.doesNotMatch(source, /^```dataviewjs\b/imu, `${id}: ${file}`);
				for (const [, target] of source.matchAll(/\]\((\.{1,2}\/[^)#]+)(?:#[^)]*)?\)/gu)) {
					const path = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(target)));
					assert.ok(path in text, `${id}: ${file} → ${path}`);
				}
			}
			for (const file of Object.keys(descriptor.text)) assert.ok(!text[file].includes('{{kb_root}}'), file);
			const views = Object.entries(text).filter(([path]) => path.endsWith('.base'));
			assert.ok(views.length);
			for (const [path, source] of views) {
				const view = parse(source);
				assert.ok(view.filters.and.includes(`file.path.startsWith("${root}/")`), path);
				assert.ok(view.filters.and.includes(`this.file.path.startsWith("${root}/")`), path);
				assert.ok(view.views.length, path);
			}
			for (const file of Object.keys(descriptor.text)) {
				assert.ok(second[file].includes(other), file);
				assert.ok(!second[file].includes(root), file);
			}
		}
		const validator = checkers[id];
		const initial = notes(text);
		const context = { template:descriptor, manifest:{ paths:{ wiki:'wiki' } }, libraryRoot:root, notes:initial };
		async function check(ctx) {
			if (descriptor.checks.some(check => check.linkEvidence)) {
				const inventory = linkInventory(text, ctx.notes);
				const resolveLink = link => fixtureTarget(text, link);
				ctx = {...ctx, links:await collectCheckLinkEvidence({vaultRoot:'.', resolveLink}, inventory, '.', root)};
			}
			const result = await validator(ctx);
			assert.equal(result.unverified ?? 0, 0);
			assert.ok(Array.isArray(result.checkedItems), id);
			return result;
		}
		const clean = await check(context);
		assert.deepEqual(clean.findings, []);
		const [path, properties, code, body] = negative[id];
		const existing = initial.find(note => note.path === path);
		const replacement = { path, properties:{ ...existing?.properties, ...properties }, body:body ?? existing?.body ?? '' };
		const result = await check({ ...context, notes:[...initial.filter(note => note.path !== path), replacement].sort((a,b)=>a.path.localeCompare(b.path)) });
		assert.ok(result.findings.some(finding => finding.code === code && finding.severity === 'warning'), JSON.stringify(result.findings));
		assert.ok(result.checkedItems.some(item => item.file === path && item.subject && item.outcome), JSON.stringify(result.checkedItems));
	});
}

test('LLM Wiki checks the mapped index by exact path and excludes fenced, inline, and human notes', async () => {
	const mapped = '知识页';
	const state = {
		libraryRoot:root,
		manifest:{ paths:{wiki:mapped,index:mapped + '/导航.md'} },
		notes:[
			{path:mapped + '/导航.md',properties:{type:'index'},body:[
				'- [第一篇](./主题一/重复标题.md)',
				'~~~markdown',
				'- [第二篇](./主题二/重复标题.md)',
				'~~~',
				'示例 `[行内](./行内引用.md)`',
			].join('\n')},
			...['主题一/重复标题','主题二/重复标题','行内引用'].map(name => ({path:`${mapped}/${name}.md`,properties:{type:'concept',managed_by:'agent'},body:''})),
			{path:mapped + '/人工笔记.md',properties:{type:'analysis',managed_by:'human'},body:''},
			{path:mapped + '/空白综述.md',properties:{type:'overview',status:'empty',managed_by:'agent'},body:''},
		],
	};
	assert.deepEqual((await llmWiki(state)).findings.map(({file,code})=>[file,code]), [
		[mapped + '/主题二/重复标题.md','knowledge-index-uncovered'],
		[mapped + '/行内引用.md','knowledge-index-uncovered'],
	]);
	state.notes[0].body += `\n- [[${root}/${mapped}/主题二/重复标题]]\n- [行内引用](./行内引用.md)`;
	const clean = await llmWiki(state);
	assert.deepEqual(clean.findings, []);
	assert.deepEqual(clean.checkedItems.map(({file}) => file),[
		mapped + '/主题一/重复标题.md',mapped + '/主题二/重复标题.md',mapped + '/行内引用.md',
	]);
	state.notes[0].body += '\n- 同一主题的进一步资料\n    - [子项](./列表子项.md)\n\n' +
		'          [缩进代码](./缩进示例.md)\n\n' +
		'  ~~~md\n  - [围栏代码](./列表代码块.md)\n  ~~~';
	for (const name of ['列表子项','缩进示例','列表代码块']) {
		state.notes.push({path:mapped + '/' + name + '.md', properties:{type:'concept',managed_by:'agent'}, body:''});
	}
	assert.deepEqual((await llmWiki(state)).findings.map(({file})=>file), [mapped + '/缩进示例.md',mapped + '/列表代码块.md']);
	state.notes[0].body += [
		'',
		'- [引用][编号 A]',
		'- [折叠引用][]',
		'[编号    a]: <./缩进示例.md> "来源"',
		'[编号 A]: ./列表代码块.md',
		'[折叠引用]: ./列表代码块.md',
	].join('\n');
	assert.deepEqual((await llmWiki(state)).findings, []);
	const index = state.notes.shift();
	const missing = await llmWiki(state);
	assert.deepEqual(missing.findings.map(({file,code})=>[file,code]), [[index.path,'knowledge-index-missing']]);
	assert.equal(missing.unverified,1);
	assert.deepEqual(missing.checkedItems,[]);
});

test('new Kepano notes can use all eight reference categories from their installed templates', async () => {
	const files = instance('kepano');
	const templates = ['Coffee','Conference Session','Email','Food','Hosting','Meditation','Quote','Show Episode'];
	for (const name of templates) files['Notes/' + name + '.md'] = files['Templates/' + name + ' Template.md'];
	files['Notes/Ordinary reference.md'] = `---\ncategories: ["[[${root}/References/Dessert]]"]\n---\n`;
	files['Notes/Foreign category.md'] = `---\ncategories: ["[[${other}/References/Coffee]]"]\n---\n`;
	const items = notes(files);
	const inventory = linkInventory(files, items);
	const links = await collectCheckLinkEvidence({vaultRoot:'.',resolveLink:link=>fixtureTarget(files,link)},inventory,'.',root);
	const result = await kepano({libraryRoot:root,notes:items,links});
	assert.equal(result.unverified,0);
	assert.deepEqual(result.findings.map(({code,file})=>[code,file]), [
		['category-link-outside-library','Notes/Ordinary reference.md'],
		['category-link-outside-library','Notes/Foreign category.md'],
	]);
	for (const name of templates)
		assert.match(result.checkedItems.find(item=>item.file==='Notes/' + name + '.md').outcome,/指向本库分类页 1 条/u);
});

test('mastered exam practice needs at least one real Gregorian attempt date', async () => {
	const practice = {path:'Practice/sample.md',properties:{type:'exam-practice',status:'mastered'}};
	for (const invalid of ['0000-01-01','2025-02-29','1900-02-29','2025-02-31','2026-04-31','2026-00-02','2026-12-00']) {
		practice.properties.attempts = [invalid];
		assert.deepEqual((await exam({notes:[practice]})).findings.map(({code})=>code),['retry-record-missing'],invalid);
	}
	practice.properties.attempts = ['2025-02-31','2000-02-29'];
	const valid = await exam({notes:[practice]});
	assert.deepEqual(valid.findings,[]);
	assert.match(valid.checkedItems[0].outcome,/2000-02-29/u);
});

test('first-week entry rejects missing, other-library, and non-diary targets', async () => {
	const initial = notes(instance('minimal-first-week'));
	const diary = initial.find(note => note.path === 'Journal/2026-09-07.md');
	for (const target of ['', '[日记入口](../他库/Journal/2026-09-07.md)', '[日记入口](./Journal/其他记录.md)']) {
		const context = {notes:[diary,{path:'Journal/其他记录.md',properties:{type:'other-note'},body:''},{path:'README.md',properties:{},body:target}]};
		assert.deepEqual((await firstWeek(context)).findings.map(finding => finding.code), ['journal-entry-invalid']);
	}
});

test('citation checks handle missing and non-link Properties values', async () => {
	const permanent = { path:'Permanent/待整理.md', properties:{type:'permanent-card',origin:'literature'}, body:'' };
	const graph = { path:'Evidence/待核对.md', properties:{type:'evidence-claim',sources:[42]}, body:'' };
	assert.deepEqual((await zettelkasten({libraryRoot:root,notes:[permanent]})).findings.map(item => item.code), ['literature-card-missing']);
	assert.deepEqual((await evidence({libraryRoot:root,notes:[graph]})).findings.map(item => item.code), ['evidence-source-invalid']);
	graph.properties.sources = [];
	assert.deepEqual((await evidence({libraryRoot:root,notes:[graph]})).findings.map(item => item.code), ['evidence-source-missing']);
});

test('YAML short links use actual resolution and keep unknown links unverified', async () => {
	const cases = [
		['ai-worklog','Decisions/采用本地索引.md','supersedes','Decisions/先试云端索引.md'],
		['coursework','Courses/实验入门/Assignments/图表作业.md','course','Courses/实验入门/课程索引.md'],
		['worldbuilding','Events/驿站换班.md','location','Places/芦汀驿站.md'],
		['zettelkasten','Permanent/理解需要检验.md','literature','Literature/示例阅读记录.md'],
		['research-project','Projects/同一份样品的重复测量.md','evidence','Records/重复测量观察.md'],
		['research-evidence','Evidence/重复测量.md','sources','Sources/读数报告.md'],
		['manuscript','Manuscript/Chapters/02-回声.md','manuscript','Manuscript/回声计划.md'],
		['kepano','References/The Machine Stops.md','categories','Categories/Books.md'],
	];
	for (const [id, path, property, target] of cases) {
		const files = instance(id);
		const initial = notes(files);
		const source = initial.find(note => note.path === path);
		assert.ok(source && files[target], id);
		const short = posix.basename(target, '.md');
		const inventory = linkInventory(files, initial);
		async function run(status, destination, written = short) {
			source.properties[property] = `[[${written}|显示名]]`;
			const resolveLink = status ? link => link.target === written ? {status, path:destination}
				: fixtureTarget(files, link) : undefined;
			const links = await collectCheckLinkEvidence({vaultRoot:'.', resolveLink}, inventory, '.', root);
			return checkers[id]({libraryRoot:root, notes:initial, links});
		}
		const resolved = await run('resolved', root + '/' + target);
		assert.deepEqual(resolved.findings, [], id);
		assert.equal(resolved.unverified, 0, id);
		assert.ok(resolved.checkedItems.some(row => row.file === path && row.subject.includes(property)), id);
		for (const result of [await run('resolved', other + '/' + target), await run('missing')]) {
			assert.equal(result.unverified, 0, id);
			assert.ok(result.findings.some(row => row.file === path && row.severity === 'warning'), id);
		}
		for (const result of [await run('unknown'), await run()]) {
			assert.equal(result.unverified, 1, id);
			assert.deepEqual(result.findings.map(row => [row.file,row.severity]), [[path,'info']], id);
		}
		if (id === 'kepano' || id === 'research-evidence') {
			const folderQualified = target.replace(/\.md$/u, '');
			const outside = await run('resolved', target, folderQualified);
			assert.ok(outside.findings.some(row => row.file === path && row.severity === 'warning'), id);
			const offline = await run(undefined, undefined, folderQualified);
			assert.ok(offline.findings.some(row => row.file === path && row.severity === 'info'), id);
		}
	}
	const files = instance('manuscript');
	const chapters = notes(files);
	const chapter = chapters.find(note => note.properties.type === 'chapter');
	chapter.properties.manuscript = `[[${root}/Outline/回声计划大纲]]`;
	const links = await collectCheckLinkEvidence({vaultRoot:'.'}, linkInventory(files, chapters), '.', root);
	assert.deepEqual((await manuscript({libraryRoot:root,notes:chapters,links})).findings.map(row => row.code), ['chapter-manuscript-invalid']);
});

test('new reading libraries have no shared flashcard deck and each question needs an answer', async () => {
	for (const [index, destination] of [root, other].entries()) {
		const files = notes(instance('domain-reading', destination));
		const term = files.find(note => note.path.startsWith('Terms/'));
		const template = files.find(note => note.path === 'Templates/术语.md');
		assert.deepEqual(term.properties.tags, []);
		assert.deepEqual(template.properties.tags, []);
		assert.deepEqual(await domainReading({notes:files}), {findings:[],checkedItems:[]});
		term.properties.review = true;
		term.properties.tags = [`flashcards/local-reading-${index}`];
		term.body += '\n\n第二问\n?\n第二个答案。\n';
		const completeResult = await domainReading({notes:files});
		assert.deepEqual(completeResult.findings, []);
		assert.deepEqual(completeResult.checkedItems.map(row => row.file), [term.path,term.path]);
		const complete = term.body;
		for(const bad of ['# 术语\n问题\n?\n答案\n','问题\n\n?\n\n答案\n']){
			term.body = bad;
			assert.deepEqual((await domainReading({notes:files})).findings.map(row=>row.code),['review-card-incomplete']);
		}
		term.body=complete;
		term.body += '\n没有答案的第三问\n?\n';
		term.properties.tags = ['flashcards/reading-example'];
		assert.deepEqual((await domainReading({notes:files})).findings.map(row => row.code), ['review-deck-missing','review-card-incomplete']);
	}
});

test('the archive task rule keeps tasks between mixed fences and ignores examples', async () => {
	const note = {path:'Archives/围栏示例.md', properties:{type:'review-project'}};
	const clean = ['````markdown','- [ ] 示例','~~~','```','- [ ] 仍在示例内','````  '].join('\n');
	assert.deepEqual((await projectReview({notes:[{...note,body:clean}]})).findings,[]);
	const unclosed = '   ~~~ example\n- [ ] 未闭合的代码示例';
	assert.deepEqual((await projectReview({notes:[{...note,body:clean+'\n'+unclosed}]})).findings,[]);
	const open = await projectReview({notes:[{...note,body:clean+'\n- [ ] 真实行动\n'+unclosed}]});
	assert.deepEqual(open.findings.map(row=>row.code),['archived-project-open-task']);
});

test('work log orders recent handoffs first and Radar derives a stage order', () => {
	const handoffs = parse(instance('ai-worklog')['Views/Work.base']).views.find(view => view.name === '最近交接');
	assert.deepEqual(handoffs.sort, [{property:'date', direction:'DESC'}]);
	const radar = parse(instance('technology-radar')['Views/Radar.base']);
	assert.deepEqual(radar.views.find(view => view.name === '按阶段').groupBy, {property:'formula.stage', direction:'ASC'});
	assert.deepEqual([...radar.formulas.stage.matchAll(/status == "(\w+)", "(\d)/gu)].map(match => match.slice(1)), [
		['assess','1'],['trial','2'],['adopt','3'],['hold','4'],
	]);
	const journal=instance('minimal-first-week');
	assert.match(journal['README.md'], /Journal\.base#首周回顾/u);
	assert.deepEqual(parse(journal['Views/Journal.base']).views.find(view=>view.name==='首周回顾').filters.and,
		['type == "week-reflection"']);
});

function workspace(activeFile, assets) {
	const files = new Map(Object.keys(assets).map(path => [path, { path, extension:path.split('.').at(-1) }]));
	const opened = [];
	const app = {
		vault:{
			getAbstractFileByPath:path => files.get(path),
			getFileByPath:path => {
				const file = files.get(path);
				return file?.extension ? file : null;
			},
			createFolder:async path => { files.set(path, { path, children:[] }); },
			create:async (path, content) => {
				assert.ok(!files.has(path), 'Existing file would be overwritten');
				const file = { path, content, extension:'md' };
				files.set(path, file);
				return file;
			},
			read:async file => assets[file.path],
		},
		workspace:{ getActiveFile:() => activeFile, getLeaf:() => ({ openFile:async file => { opened.push(file.path); } }) },
	};
	return { app, files, opened };
}

function quickAdd(content) {
	const CommonJS = { exports:{} };
	new Script(content).runInNewContext({ module:CommonJS });
	return CommonJS.exports;
}

function templater(content) {
	assert.match(content, /^<%\*\n[\s\S]+\n%>\n$/u);
	return new Script(`(async (tp, app, moment) => {${content.slice(4, -4)}})`).runInNewContext();
}

test('media capture creates a typed work inside the active library and rejects a path as its title', async () => {
	const source = instance('media-tracker');
	const create = quickAdd(source['Integrations/新增作品或合集.js']);
	const assets = Object.fromEntries(Object.entries(source).map(([path, value]) => [`${root}/${path}`, value]));
	const { app, files, opened } = workspace({ name:'README.md', parent:{ path:root } }, assets);
	await create({ app, quickAddApi:{ suggester:async () => '播客', inputPrompt:async () => '新作品' } });
	const path = `${root}/Media/新作品.md`;
	assert.match(files.get(path).content, /medium: "podcast"/u);
	assert.match(files.get(path).content, /# 新作品/u);
	assert.deepEqual(opened, [path]);
	await create({ app, quickAddApi:{ suggester:async () => '合集', inputPrompt:async () => '新合集' } });
	assert.match(files.get(`${root}/Collections/新合集.md`).content, /# 新合集/u);
	await assert.rejects(create({ app, quickAddApi:{ suggester:async () => '合集', inputPrompt:async () => '../越界' } }), /文件名/u);
	await create({ app, quickAddApi:{ suggester:async () => 'toString', inputPrompt:async () => assert.fail('Unexpected choice reached the title prompt') } });
	assert.ok(!files.has(`${other}/Media/新作品.md`));
	const unbound = {
		...assets,
		[`${root}/Templates/媒体合集.md`]:packs['media-tracker'].text['Templates/媒体合集.md']+'\n建于 {{date}}。\n',
	};
	const unboundWorkspace = workspace({name:'README.md',parent:{path:root}},unbound);
	await create({app:unboundWorkspace.app,quickAddApi:{suggester:async ()=>'合集',inputPrompt:async ()=>'移库后新合集'}});
	const collection = unboundWorkspace.files.get(`${root}/Collections/移库后新合集.md`).content;
	assert.ok(collection.includes(`FROM "${root}/Media"`));
	assert.match(collection,/建于 \d{4}-\d{2}-\d{2}。/u);
	assert.doesNotMatch(collection,/\{\{/u);
});

test('GTD recurring action advances its interval and clamps a leap-year month', async () => {
	const file = { parent:{ name:'Actions', parent:{ path:root } } };
	const advance = quickAdd(instance('gtd')['Integrations/推进重复行动.js']);
	const { app } = workspace(file, { [`${root}/Views/Actions.base`]:'' });
	const properties = { type:'gtd-action', status:'next', every:'1m', next:'2028-01-31' };
	app.fileManager = { processFrontMatter:async (target, update) => { assert.equal(target, file); update(properties); } };
	await advance({ app });
	assert.equal(properties.next, '2028-02-29');
	assert.equal(properties.status, 'next');
	properties.every = ['1m'];
	await assert.rejects(advance({ app }), /every/u);
	assert.equal(properties.next, '2028-02-29');
});

test('explicit Templater actions respect their instance, preserve existing course files, and generate a scoped weekly query', async () => {
	const course = templater(instance('coursework')['Integrations/建立课程结构.md']);
	const config = { target_file:{ path:`${root}/README.md` } };
	const { app, files } = workspace(config.target_file, {});
	const tp = { config, system:{ prompt:async () => '信号课程' } };
	await course(tp, app);
	const entry = `${root}/Courses/信号课程/课程索引.md`;
	assert.ok(files.has(`${root}/Courses/信号课程/Assignments`));
	assert.match(files.get(entry).content, /type: course/u);
	const created = files.get(entry);
	await course(tp, app);
	assert.equal(files.get(entry), created);
	await assert.rejects(course({ ...tp, config:{ target_file:{ path:`${other}/README.md` } } }, app), /本库/u);
	const weekly = templater(instance('project-review')['Integrations/建立本周回顾.md']);
	const dateMock = () => ({ format:pattern => pattern === 'YYYY-MM-DD' ? '2026-09-27' : '2026-W39', isValid:()=>true, endOf:()=>dateMock() });
	await weekly({ config, system:{ prompt:async () => '2026-W39' } }, app, dateMock);
	assert.ok(files.get(`${root}/Reviews/2026-W39.md`).content.includes(`task.file.path.startsWith("${root}/Projects/")`));
	const archive = templater(instance('minimal-journal')['Integrations/归档当前札记.md']);
	const journalFile = { path:`${root}/Notes/待归档.md`, name:'待归档.md', parent:{ path:`${root}/Notes` } };
	app.metadataCache = { getFileCache:()=>({ frontmatter:{type:'jot',date:'2026-09-07'} }) };
	let moved;
	app.fileManager = { renameFile:async (target, path) => { assert.equal(target, journalFile); moved = path; } };
	await archive({ config:{ target_file:journalFile } }, app);
	assert.equal(moved, `${root}/Notes/2026/待归档.md`);
});

test('the revised template checks retain trusted v4 scripts', () => {
	const published = {
		'knowledge-garden': '40f0d2a04f46f39cf18562461d8d4755243786891b46465df9b6c8d2a147401b',
		'media-tracker': 'bc5bea045030cde26cd6a37f75331614c5a411c297a5ab4dbb6e7cf5becd9224',
		manuscript: '36ecc4b50525c045c05986358bb6719554e81a561c7058f39488b1212aab58fe',
		gtd: '916c536b38660c4f6f8c2b99a902912669de69a40cd94b23a106ac90d7b4ce00',
		worldbuilding: '39c228000b86ea882db8694737b2c459f25ae444076cb8f958c3c334f11f8720',
	};
	for (const [id, digest] of Object.entries(published)) {
		assert.equal(packs[id].descriptor.version, '5', id);
		assert.ok(digests.includes(digest), id);
	}
});

test('the garden warns when a page marked for sharing is itself private', async () => {
	const inputs = [
		{path:'Guides/拟分享的私有条目.md', properties:{type:'garden-note', publish_ready:true, visibility:'private'}},
		{path:'Guides/拟分享的公开条目.md', properties:{type:'garden-note', publish_ready:true, visibility:'public'}},
		{path:'Drafts/仅内部使用.md', properties:{type:'garden-note', publish_ready:false, visibility:'private'}},
	];
	const links = Object.fromEntries(inputs.map(note => [note.path,{complete:true,references:[]}]));
	const result = await garden({notes:inputs,links});
	assert.deepEqual(result.findings.map(({file,code,severity}) => [file,code,severity]), [
		[inputs[0].path,'sharing-private-page','warning'],
	]);
	assert.equal(result.unverified, 0);
});

test('only completed media need a finished field for the annual summary', async () => {
	const variants = [
		['Media/没有日期.md',{status:'completed'}],
		['Media/日期为空.md',{status:'completed',finished:''}],
		['Media/日期是空白.md',{status:'completed',finished:'  '}],
		['Media/已记日期.md',{status:'completed',finished:'2026-04-01'}],
		['Media/仍在体验.md',{status:'active'}],
	];
	const result = await mediaTracker({notes:variants.map(([path, properties]) => ({
		path, properties:{type:'media-item', ...properties},
	}))});
	assert.deepEqual(result.findings.map(({file,code}) => [file,code]),
		variants.slice(0,3).map(([file]) => [file,'media-finished-missing']));
	assert.deepEqual(result.checkedItems.map(({file}) => file), variants.slice(0,4).map(([file]) => file));
});

test('a manuscript chapter can leave both fields empty or fill both', async () => {
	const variants = [
		['草稿',{chapter:'',manuscript:null}],
		['缺编号',{chapter:null,manuscript:'[[Manuscript/书稿]]'}],
		['缺书稿',{chapter:2,manuscript:' '}],
		['已编排',{chapter:1,manuscript:'[[Manuscript/书稿]]'}],
	];
	const result = await manuscript({notes:[
		{path:'Manuscript/书稿.md',properties:{type:'manuscript'}},
		...variants.map(([name, properties]) => ({path:'Manuscript/Chapters/'+name+'.md',properties:{type:'chapter',...properties}})),
	]});
	assert.deepEqual(result.findings.map(({file,code}) => [file,code]), [
		['Manuscript/Chapters/缺编号.md','chapter-order-missing'],
		['Manuscript/Chapters/缺书稿.md','chapter-manuscript-missing'],
	]);
	assert.ok(result.checkedItems.some(({file}) => file==='Manuscript/Chapters/已编排.md'));
	assert.ok(result.checkedItems.every(({file}) => file!=='Manuscript/Chapters/草稿.md'));
});

test('GTD checks the folder and follow-up for waiting actions outside Actions too', async () => {
	const variants = [
		['Actions/项目/有效.md',{follow_up:'2028-02-29'}],
		['Actions/日期无效.md',{follow_up:'2025-02-29'}],
		['Inbox/原地转等待.md',{follow_up:'2026-04-01'}],
		['Inbox/原地转等待且日期无效.md',{follow_up:'2025-04-31'}],
		['Templates/等待.md',{}],
		['Integrations/等待.md',{}],
		['Actions/下一步.md',{status:'next'}],
	];
	const result = await gtd({notes:variants.map(([path,properties]) => ({
		path, properties:{type:'gtd-action',status:'waiting',...properties},
	}))});
	assert.deepEqual(result.findings.map(({file,code}) => [file,code]), [
		[variants[1][0],'waiting-follow-up-missing'],
		[variants[2][0],'waiting-action-outside-actions'],
		[variants[3][0],'waiting-action-outside-actions'],
		[variants[3][0],'waiting-follow-up-missing'],
	]);
	assert.ok(result.checkedItems.some(({file}) => file===variants[0][0]));
});

test('worldbuilding checks Gregorian dates without applying a calendar to fictional dates', async () => {
	const variants = [
		['无效开始',{start:'2025-02-31',end:'2025-02-01'}],
		['无效结束',{start:'星历 3 年 9 月',end:'2100-02-29'}],
		['闰日',{start:'2000-02-29',end:'2000-03-01'}],
		['架空纪年',{start:'星历 3 年 9 月',end:'星历 4 年 1 月'}],
		['草案',{start:'',end:null}],
	];
	const result = await worldbuilding({notes:variants.map(([name,properties]) => ({
		path:'Events/'+name+'.md',properties:{type:'world-event',...properties},
	}))});
	assert.deepEqual(result.findings.map(({file,code}) => [file,code]), [
		['Events/无效开始.md','event-date-invalid'],
		['Events/无效结束.md','event-date-invalid'],
	]);
	assert.ok(result.checkedItems.some(({file,subject}) => file==='Events/闰日.md' && subject.includes('先后顺序')));
	assert.ok(result.checkedItems.every(({file}) => file!=='Events/架空纪年.md' && file!=='Events/草案.md'));
});
