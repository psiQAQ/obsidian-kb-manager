import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {runDiagnostics} from '../src/diagnostics/index.ts';
import {linkCandidateIndex} from '../src/diagnostics/links.ts';

const library = 'libraries/current';
const neighbor = 'libraries/other';
const nested = `${neighbor}/nested`;
const node = {x:0, y:0, width:160, height:100};
const check = (report, id) => report.checks.find(item => item.id === id);

async function fixture(t) {
	const workspace = path.resolve('.tmp');
	await fs.mkdir(workspace, {recursive:true});
	const vault = await fs.mkdtemp(path.join(workspace, 'canvas-portability-'));
	t.after(async () => {
		assert.equal(path.dirname(path.resolve(vault)), workspace);
		await fs.rm(vault, {recursive:true, force:true});
	});
	const put = async (file, content) => {
		const filename = path.join(vault, file);
		await fs.mkdir(path.dirname(filename), {recursive:true});
		await fs.writeFile(filename, content);
	};
	await put(`${library}/kb.toml`, 'version = 1\n');
	const libraryRoot = path.join(vault, library);
	await fs.mkdir(path.join(libraryRoot, '.log'));
	return {put, options:{vaultRoot:vault, libraryRoot, registeredPaths:[library, neighbor, nested]}};
}

test('Canvas reports cross-library file, group and text references once for either selection', async t => {
	const {put, options} = await fixture(t);
	const file = `${nested}/notes/Paper.md`;
	const background = `${neighbor}/media/Scene.png`;
	const foreignText = `${neighbor}/notes/Topic.md`;
	const localText = `${library}/notes/Topic.md`;
	const localOther = `${library}/folder/Local.md`;
	const foreignOther = `${neighbor}/Folder/Local.md`;
	const unrelated = `${neighbor}/othernotes/Topic.md`;
	const paths = [file, background, foreignText, localText, localOther, foreignOther, unrelated];
	for (const filename of paths) await put(filename, 'Fixture');
	await put(`${library}/sample.canvas`, JSON.stringify({nodes:[
		{...node,id:'file-node',type:'file',file},
		{...node,id:'group-node',type:'group',background},
		{...node,id:'text-node',type:'text',text:'Intro\n[[notes/Topic]]\n[[folder/Local]]\n[Exact](./folder/Local.md)'},
	]}));
	const targets = new Map([[file,file], [background,background], ['notes/Topic',foreignText], ['folder/Local',localOther], ['./folder/Local.md',localOther]]);
	const reported = [];
	const resolveLink = request => {
		reported.push(request);
		return {status:'resolved',path:targets.get(request.target)};
	};
	const run = async selected => {
		reported.length = 0;
		const report = await runDiagnostics({...options,selected,resolveLink,linkCandidates:linkCandidateIndex(() => paths)});
		assert.deepEqual(reported.map(request => request.target), [...targets.keys()]);
		assert.ok(reported.every(request => request.source === `${library}/sample.canvas`));
		assert.deepEqual(reported.map(request => !!request.canvasPath), [true,true,false,false,false]);
		return report;
	};
	const onlyCanvas = check(await run(['canvas']), 'canvas');
	assert.deepEqual(onlyCanvas.diagnostics.map(row => [row.code,row.severity,row.file]),
		Array.from({length:3}, () => ['cross-library-link','info','sample.canvas']));
	assert.ok(onlyCanvas.diagnostics[0].evidence.includes(`${file} · 所属库 ${nested} · 节点 file-node`));
	assert.ok(onlyCanvas.diagnostics[1].evidence.includes(`${background} · 所属库 ${neighbor} · 节点 group-node`));
	assert.ok(onlyCanvas.diagnostics[2].evidence.includes(`${foreignText} · 所属库 ${neighbor} · 节点 text-node · 文本行 2`));

	const onlyPortability = check(await run(['portability']), 'portability');
	assert.equal(onlyPortability.coverage.checked, 5);
	assert.deepEqual(onlyPortability.diagnostics.map(row => row.code), [
		'external-library-dependency','external-library-dependency','external-library-dependency','same-name-candidates',
	]);
	const crossText = onlyPortability.diagnostics[2].evidence;
	assert.ok(crossText.includes(`所属库 ${neighbor}`));
	assert.ok(crossText.includes(`同名候选 ${localText}、${foreignText}`));
	assert.ok(!crossText.includes(unrelated));
	const sameName = onlyPortability.diagnostics[3];
	assert.match(sameName.evidence, /文本行 3/u);
	assert.ok(sameName.evidence.includes(`同名候选 ${localOther}、${foreignOther}`));

	const combined = await run(['canvas','portability']);
	assert.deepEqual(check(combined,'portability'), onlyPortability);
	assert.equal(check(combined,'canvas').status, 'passed');
});

test('Canvas portability keeps offline targets and unreadable syntax unknown', async t => {
	const {put, options} = await fixture(t);
	const local = `${library}/notes/Local.md`;
	const foreign = `${neighbor}/notes/Local.md`;
	await put(local, 'Local');
	await put(foreign, 'Foreign');
	await put(`${library}/sample.canvas`, JSON.stringify({nodes:[
		{...node,id:'local',type:'file',file:local},
		{...node,id:'foreign',type:'group',background:foreign},
		{...node,id:'text',type:'text',text:'[[notes/Local]]'},
	]}));
	await put(`${library}/invalid.canvas`, 'Malformed Canvas');
	await put(`${library}/unreadable.canvas`, Buffer.from([0xff]));
	const portability = check(await runDiagnostics({...options,selected:['portability']}), 'portability');
	assert.equal(portability.status, 'partial');
	assert.equal(portability.coverage.checked, 1);
	assert.equal(portability.coverage.unknown, 4);
	const locations = ({diagnostics}) => diagnostics.map(({code,file}) => [code,file]);
	assert.deepEqual(locations(portability), [
		['canvas-json','invalid.canvas'],
		['canvas-target-unverified','sample.canvas'],
		['canvas-text-link-unverified','sample.canvas'],
		['unreadable-file','unreadable.canvas'],
	]);
	assert.ok(portability.diagnostics[1].evidence.includes(foreign));
	assert.match(portability.reason, /Canvas/u);
	const both = await runDiagnostics({...options,selected:['canvas','portability']});
	assert.deepEqual(check(both,'portability').coverage, portability.coverage);
	assert.deepEqual(locations(check(both,'portability')), locations(portability));
	assert.deepEqual(locations(check(both,'canvas')), locations(portability));
});

test('Markdown links use the same path suffix matching for candidate evidence', async t => {
	const {put, options} = await fixture(t);
	const local = `${library}/notes/Topic.md`;
	const foreign = `${neighbor}/notes/Topic.md`;
	const wrongFolder = `${neighbor}/not-notes/Topic.md`;
	await put(local, 'Local');
	await put(`${library}/source.md`, '[[notes/Topic]]\n[Exact](./notes/Topic.md)');
	const report = await runDiagnostics({...options,selected:['portability'],
		resolveLink:() => ({status:'resolved',path:local}), linkCandidates:() => [local, foreign, wrongFolder]});
	const [{code,line,evidence}, ...rest] = check(report,'portability').diagnostics;
	assert.equal(code, 'same-name-candidates');
	assert.equal(line, 1);
	assert.ok(evidence.includes(`同名候选 ${local}、${foreign}`));
	assert.deepEqual(rest, []);
});
