// node scripts/desktop-qa.mjs <artifact-directory> <revision> [0,10,100]
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { json, launchDesktop, managerType, pluginId, prepareRun, trustFixture, until, workspaceScratch } from './desktop-qa-host.mjs';

const [directory, revision, sizes = '0,10,100'] = process.argv.slice(2);
assert(directory && /^[a-f0-9]{7,40}$/u.test(revision ?? ''), 'Pass a built plugin directory and its source commit');
const libraries = sizes.split(',').map(Number);
assert(libraries.length && libraries.every(size => [0, 10, 100].includes(size)), 'Pass 0, 10 or 100 libraries');
const executable = process.env.KB_QA_OBSIDIAN ?? join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe');
const scratch = await workspaceScratch();
const artifact = resolve(directory);
const results = [];
let failed = false;

function summarize(phase) {
	const groups = {};
	for (const [path, value] of Object.entries(phase.reads)) {
		const category = path.endsWith('/kb.toml') ? 'manifests' : path.endsWith('.md') ? 'notes' :
			path.endsWith('/data.json') ? 'pluginData' : 'other';
		const totals = groups[category] ??= { unique: 0, calls: 0, bytes: 0 };
		totals.unique++;
		totals.calls += value.calls;
		totals.bytes += value.bytes;
	}
	return {
		ms: phase.ms,
		operations: Object.values(phase.operations).reduce((sum, count) => sum + count, 0),
		reads: groups,
	};
}

for (const size of libraries) {
	const registered = Array.from({ length: size }, (_, index) => 'Library-' + String(index + 1).padStart(3, '0'));
	const fixture = await prepareRun(scratch, { label: 'baseline-' + size, artifact, libraries: registered, instrument: true });
	process.stdout.write(fixture.run + '\n');
	const result = { revision, app: {}, pluginVersion: fixture.manifest.version, registeredCount: size };
	await json(join(fixture.run, 'fixture.json'), { revision, artifact, registered, expectedMarkdownFiles: size * 2 });
	for (const [index, name] of registered.entries()) {
		const root = join(fixture.vault, name);
		await mkdir(root);
		await writeFile(join(root, 'kb.toml'), `version = 2

[manager]
schemaVersion = 2
id = "10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}"
displayName = "${name}"
description = "Desktop performance fixture"
archived = false
entry = "README.md"

[manager.template]
id = "directory"
version = "1"
`);
		await writeFile(join(root, 'README.md'), '# Read me\n\n[[Details]]\n');
		await writeFile(join(root, 'Details.md'), '---\ntags: [baseline]\n---\n# Details\n\nA short fixture note.\n');
	}
	let desktop;
	try {
		desktop = await launchDesktop(fixture, executable, 'bootstrap-process');
		await trustFixture(desktop);
		await desktop.close();
		desktop = undefined;
		desktop = await launchDesktop(fixture, executable);
		result.app = { pid: desktop.pid, browser: desktop.browser };
		const startup = await until(() => desktop.evaluate((id, launchTime) => {
			if (!window.kbDesktopStartup || !window.app.workspace.layoutReady || !window.app.commands.commands[id + ':open-manager']) return;
			return {
				sample: window.kbDesktopStartup,
				processToReadyMs: Math.round(performance.timeOrigin + performance.now() - launchTime),
				obsidian: window.require('electron').ipcRenderer.sendSync('version'),
			};
		}, pluginId, desktop.started), 'plugin startup');
		result.app.obsidian = startup.obsidian;
		result.processToReadyMs = startup.processToReadyMs;
		result.startup = startup.sample;
		await desktop.evaluate((id) => {
			window.kbDesktopMeasurements.begin();
			if (!window.app.commands.executeCommandById(id + ':open-manager')) throw new Error('Manager command unavailable');
		}, pluginId);
		const measurePanel = () => until(() => desktop.evaluate((viewType, names) => {
			const workspace = window.app.workspace;
			const leaf = workspace.getLeavesOfType(viewType).find(leaf => leaf.getRoot() === workspace.rightSplit);
			const root = leaf?.view.contentEl;
			if (!root?.checkVisibility() || !root.classList.contains('kb-manager-sidebar')) return;
			const rows = [...root.querySelectorAll('.setting-item-name')].map(row => row.textContent.trim());
			const visible = names.length ? names.every(name => rows.includes(name)) : root.querySelector('.kb-manager-empty');
			if (!visible) return;
			return { ...window.kbDesktopMeasurements.snapshot(), rows: names.filter(name => rows.includes(name)).length };
		}, managerType, registered), 'first complete panel render');
		result.panelOpen = await measurePanel();
		await desktop.evaluate(() => {
			const control = document.querySelector('.kb-manager-sidebar .kb-manager-heading .clickable-icon');
			if (!control) throw new Error('Manager refresh button unavailable');
			window.kbDesktopPreviousHeading=control;
			window.kbDesktopMeasurements.begin();
			control.click();
		});
		await until(()=>desktop.evaluate(()=>!window.kbDesktopPreviousHeading.isConnected),'manual refresh to replace the previous panel');
		result.panelRefresh = await measurePanel();
		if (size) {
			await desktop.evaluate(name => {
				const row = [...document.querySelectorAll('.kb-manager-sidebar .setting-item')]
					.find(row => row.querySelector('.setting-item-name')?.textContent.trim() === name);
				const control = row?.querySelector('.clickable-icon');
				if (!control) throw new Error('Library action menu unavailable');
				window.kbDesktopMeasurements.begin();
				control.click();
			}, registered[0]);
			await until(() => desktop.evaluate(() => {
				const item = [...document.querySelectorAll('.menu .menu-item')]
					.find(item => item.checkVisibility() && item.textContent.trim() === 'Check library');
				if (!item) return;
				item.click();
				return true;
			}), 'library check menu');
			result.chooseCheck = await until(() => desktop.evaluate(() => {
				const modal = document.querySelector('.modal.kb-v3-health');
				const select = modal?.querySelector('select');
				if (!select?.checkVisibility()) return;
				select.value = 'custom';
				select.dispatchEvent(new Event('change', { bubbles: true }));
				const choices = [...modal.querySelectorAll('.kb-v3-check-choice')];
				const choice = choices.find(row => row.textContent.trim().startsWith('Manifest and registration'));
				if (!choice) throw new Error('Manifest diagnostic checkbox unavailable');
				choice.querySelector('input').click();
				return window.kbDesktopMeasurements.snapshot();
			}), 'custom manifest check option');
			await desktop.evaluate(() => {
				const run = [...document.querySelectorAll('.modal.kb-v3-health button')]
					.find(button => button.textContent.trim() === 'Start check');
				if (!run || run.disabled) throw new Error('Start check action unavailable');
				window.kbDesktopMeasurements.begin();
				run.click();
			});
			result.manifestCheck = await until(() => desktop.evaluate(() => {
				const output = document.querySelector('.modal.kb-v3-health .kb-v3-check-output');
				if (!output?.querySelector('.kb-v3-status')) return;
				return { ...window.kbDesktopMeasurements.snapshot(), reportText: output.innerText };
			}), 'manifest-only report');
			const logRoot = join(fixture.vault, registered[0], '.log');
			const log = (await readdir(logRoot)).find(name => name.endsWith('.json'));
			const report = JSON.parse(await readFile(join(logRoot, log), 'utf8'));
			assert.equal(report.environment, 'desktop');
			assert.deepEqual(report.checks.map(check => check.id), ['manifest']);
			assert.equal(report.status, 'passed');
			result.report = { status: report.status, runId: report.runId, library: registered[0], log, checkIds: ['manifest'] };
		} else {
			result.manifestCheck = { status: 'Not Run', reason: 'The empty registry has no library action menu' };
		}
		result.status = 'Passed';
	} catch (error) {
		result.status = 'Failed';
		result.error = error.stack;
		result.renderer = await desktop?.evaluate(id => ({
			ready: window.app.workspace.layoutReady, enabled: window.app.plugins.isEnabled(), installed: window.app.plugins.manifests[id],
			plugins: Object.keys(window.app.plugins.plugins), sampled: Boolean(window.kbDesktopStartup),
			clicked: window.kbFixtureTrustClicked,
			modals: [...document.querySelectorAll('.modal')].map(modal => modal.innerText),
			notices: [...document.querySelectorAll('.notice')].map(notice => notice.innerText),
		}), pluginId).catch(() => undefined);
		result.rendererErrors = desktop?.errors;
		failed = true;
		console.error(error);
	} finally {
		try { await desktop?.close(); }
		catch (error) { result.cleanupError = String(error); failed = true; }
		await json(join(fixture.run, 'baseline.json'), result);
	}
	const summary = { run: fixture.run, registeredCount: size, status: result.status, ...result.app };
	if (result.startup) summary.startup = { ...summarize(result.startup), processToReadyMs: result.processToReadyMs };
	for (const field of ['panelOpen', 'panelRefresh', 'chooseCheck', 'manifestCheck']) {
		if (result[field]) summary[field] = result[field].reads ? summarize(result[field]) : result[field];
	}
	results.push(summary);
	process.stdout.write(JSON.stringify(summary) + '\n');
}

await json(join(scratch, 'baseline-' + revision + '.json'), results);
if (failed) process.exitCode = 1;
