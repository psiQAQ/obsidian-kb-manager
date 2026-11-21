import { strict as assert } from 'node:assert';
import { posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { parse } from 'yaml';
import { templateCatalog } from '../scripts/template-catalog.mjs';
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
const { renderKepano } = await import('../src/kb/kepano.ts');
const root = 'Libraries/测试库 + 样例';
const other = 'Libraries/他库';
const decoder = new TextDecoder();
const checkers = {
	'llm-wiki':llmWiki, 'ai-worklog':aiWorklog, kepano, 'media-tracker':mediaTracker, 'knowledge-garden':garden,
	'technology-radar':radar, coursework, 'exam-practice':exam, gtd, 'project-review':projectReview, 'domain-reading':domainReading,
	zettelkasten, 'research-evidence':evidence, 'research-project':project, 'minimal-first-week':firstWeek, 'minimal-journal':journal, manuscript, worldbuilding,
};

function instance(id, destination = root) {
	return Object.fromEntries(renderPack(id, { destination, displayName:'测试库', description:'实例验证' }).files
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

const negative = {
	'ai-worklog': ['Decisions/先试云端索引.md', { supersedes:`[[${root}/Decisions/采用本地索引]]` }, 'decision-cycle'],
	'llm-wiki': ['wiki/示例分析.md', { type:'analysis', managed_by:'agent' }, 'analysis-evidence-missing'],
	'kepano': ['References/The Machine Stops.md', { categories:[`[[${other}/Categories/Books]]`] }, 'category-link-outside-library'],
	'media-tracker': ['Media/远岸电台.md', { progress:7 }, 'invalid-media-progress'],
	'knowledge-garden': ['Guides/如何记录检索失败.md', { related:[`[[${root}/Drafts/内部提纲]]`] }, 'sharing-private-reference'],
	'technology-radar': ['Radar/本地全文索引.md', { adoption_reason:'' }, 'radar-adoption-unsupported'],
	'coursework': ['Courses/实验入门/Assignments/图表作业.md', { due:'2026-02-30' }, 'assignment-schedule-invalid'],
	'exam-practice': ['Practice/读时间复杂度.md', { attempts:[] }, 'retry-record-missing'],
	'gtd': ['Actions/等待确认取样时间.md', { follow_up:'' }, 'waiting-follow-up-missing'],
	'project-review': ['Archives/公开说明.md', {}, 'archived-project-open-task', '\n- [ ] 漏做的行动'],
	'domain-reading': ['Terms/对照条件.md', {}, 'review-card-incomplete', '问题\n?\n'],
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
	assert.equal(digests.length, 19);
	assert.ok(digests.includes('2d3b01e0c37a95558ba2c785a3370febf7e990fad02d130169c65bea0a00bb9f'), 'knowledge-garden v1 stays trusted');
	const purposes = new Map();
	const dependencies = new Set();
	for (const { descriptor, text } of Object.values(packs)) {
		purposes.set(descriptor.purpose, (purposes.get(descriptor.purpose) ?? 0) + 1);
		for (const dependency of descriptor.dependencies ?? []) dependencies.add(dependency);
		assert.ok(text[descriptor.entry], descriptor.id);
		for (const source of descriptor.sources) assert.match(source.commit, /^[a-f0-9]{40}$/u);
		assert.ok([...Object.keys(text), ...Object.keys(packs[descriptor.id].binary)].every(path => path.split('/').every(part =>
			!part.startsWith('.') || ['.gitignore', '.gitattributes', '.gitkeep'].includes(part))));
	}
	assert.equal(purposes.size, 9);
	for (const count of purposes.values()) assert.equal(count, 2);
	assert.deepEqual(Array.from(dependencies).sort(), ['dataview','obsidian-meta-bind-plugin','obsidian-spaced-repetition','obsidian-tasks-plugin','quickadd','templater-obsidian']);
});

for (const [id, pack] of Object.entries(packs)) {
	test(`${id} has usable starter links and distinct passing and failing check inputs`, async () => {
		const { descriptor } = pack;
		const legacy = ['llm-wiki', 'kepano'].includes(id);
		const text = id === 'kepano' ? renderKepano(pack.text, root) : instance(id);
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
			const second = instance(id, other);
			for (const file of Object.keys(descriptor.text)) {
				assert.ok(second[file].includes(other), file);
				assert.ok(!second[file].includes(root), file);
			}
		}
		const validator = checkers[id];
		const initial = notes(text);
		const context = { template:descriptor, manifest:{ paths:{ wiki:'wiki' } }, libraryRoot:root, notes:initial };
		async function findings(ctx) {
			if (id !== 'knowledge-garden') return validator(ctx);
			const inventory = {files:new Set(Object.keys(text)), excluded:new Set(), unreadableDirectories:new Set(),
				notes:ctx.notes.map(note => ({...note, lineOffset:0}))};
			const links = await collectCheckLinkEvidence({vaultRoot:'.'}, inventory, '.', root);
			const result = await validator({...ctx, links});
			assert.equal(result.unverified, 0);
			return result.findings;
		}
		assert.deepEqual(await findings(context), []);
		const [path, properties, code, body] = negative[id];
		const existing = initial.find(note => note.path === path);
		const replacement = { path, properties:{ ...existing?.properties, ...properties }, body:body ?? existing?.body ?? '' };
		const violations = await findings({ ...context, notes:[...initial.filter(note => note.path !== path), replacement].sort((a,b)=>a.path.localeCompare(b.path)) });
		assert.ok(violations.some(finding => finding.code === code && finding.severity === 'warning'), JSON.stringify(violations));
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
	assert.deepEqual((await llmWiki(state)).map(({file,code})=>[file,code]), [
		[mapped + '/主题二/重复标题.md','knowledge-index-uncovered'],
		[mapped + '/行内引用.md','knowledge-index-uncovered'],
	]);
	state.notes[0].body += `\n- [[${root}/${mapped}/主题二/重复标题]]\n- [行内引用](./行内引用.md)`;
	assert.deepEqual(await llmWiki(state), []);
});

test('first-week entry rejects missing, other-library, and non-diary targets', async () => {
	const initial = notes(instance('minimal-first-week'));
	const diary = initial.find(note => note.path === 'Journal/2026-09-07.md');
	for (const target of ['', '[日记入口](../他库/Journal/2026-09-07.md)', '[日记入口](./Journal/其他记录.md)']) {
		const context = {notes:[diary,{path:'Journal/其他记录.md',properties:{type:'other-note'},body:''},{path:'README.md',properties:{},body:target}]};
		assert.deepEqual((await firstWeek(context)).map(finding => finding.code), ['journal-entry-invalid']);
	}
});

test('citation checks handle missing and non-link Properties values', async () => {
	const permanent = { path:'Permanent/待整理.md', properties:{type:'permanent-card',origin:'literature'}, body:'' };
	const graph = { path:'Evidence/待核对.md', properties:{type:'evidence-claim',sources:[42]}, body:'' };
	assert.deepEqual((await zettelkasten({libraryRoot:root,notes:[permanent]})).map(item => item.code), ['literature-card-missing']);
	assert.deepEqual((await evidence({libraryRoot:root,notes:[graph]})).map(item => item.code), ['evidence-source-invalid']);
});

function workspace(activeFile, assets) {
	const files = new Map(Object.keys(assets).map(path => [path, { path, extension:path.split('.').at(-1) }]));
	const opened = [];
	const app = {
		vault:{
			getAbstractFileByPath:path => files.get(path),
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
	assert.match(files.get(path).content, /medium: podcast/u);
	assert.match(files.get(path).content, /# 新作品/u);
	assert.deepEqual(opened, [path]);
	await assert.rejects(create({ app, quickAddApi:{ suggester:async () => '合集', inputPrompt:async () => '../越界' } }), /文件名/u);
	assert.ok(!files.has(`${other}/Media/新作品.md`));
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
