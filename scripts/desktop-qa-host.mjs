import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { clearTimeout as cancelDeadline, setTimeout as deadlineTimer } from 'node:timers';
import { setTimeout as pause } from 'node:timers/promises';
import { defaultConfigDir } from '../src/fs/segments.ts';
import { instrumentVault } from './desktop-qa-measure.mjs';

export const pluginId = 'knowledge-base-manager';
export const managerType = pluginId + '-view';

export async function until(callback, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	do {
		const found = await callback();
		if (found) return found;
		await pause(30);
	} while (Date.now() < deadline);
	throw new Error('Timed out waiting for ' + label);
}

export const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

export async function workspaceScratch() {
	let root = import.meta.dirname;
	while (!(await stat(join(root, '.git')).catch(() => null))?.isDirectory()) {
		assert.notEqual(root, dirname(root), 'Run this script inside the repository or its nested worktree');
		root = dirname(root);
	}
	const commonRoot = await realpath(root);
	const scratch = join(commonRoot, '.tmp', 'plugin-improvement-qa');
	await mkdir(scratch, { recursive: true });
	assert.equal(await realpath(scratch), scratch, 'Refusing a redirected QA root');
	return scratch;
}

export async function prepareRun(scratch, { label, artifact, libraries = [], instrument = false, templater }) {
	assert.match(label, /^[a-z0-9-]+$/u);
	const run = await mkdtemp(join(scratch, label + '-'));
	const vault = join(run, 'QA ' + label);
	const profile = join(run, 'profile');
	const temp = join(run, 'temp');
	const config = join(vault, defaultConfigDir);
	const installed = join(config, 'plugins', pluginId);
	for (const directory of [installed, profile, temp]) await mkdir(directory, { recursive: true });
	const manifest = JSON.parse(await readFile(join(artifact, 'manifest.json'), 'utf8'));
	assert.equal(manifest.id, pluginId);
	await copyFile(join(artifact, 'manifest.json'), join(installed, 'manifest.json'));
	await copyFile(join(artifact, 'styles.css'), join(installed, 'styles.css'));
	let bundle = await readFile(join(artifact, 'main.js'), 'utf8');
	if (instrument) {
		bundle = `(${instrumentVault})(${JSON.stringify(vault)}, require);\n${bundle}\n`
			+ 'const InstrumentedPlugin = module.exports;\n'
			+ 'class MeasuredPlugin extends InstrumentedPlugin {\n'
			+ '  async onload() {\n'
			+ '    window.kbDesktopMeasurements.observeRegistry(this.app.vault.adapter, this.manifest.dir + "/data.json");\n'
			+ '    window.kbDesktopMeasurements.begin();\n'
			+ '    try { await super.onload(); }\n'
			+ '    finally { window.kbDesktopStartup = window.kbDesktopMeasurements.snapshot(); }\n'
			+ '  }\n'
			+ '}\n'
			+ 'module.exports = MeasuredPlugin;\n';
	}
	await writeFile(join(installed, 'main.js'), bundle);
	const ids = [pluginId];
	if (templater) {
		const templateManifest = JSON.parse(await readFile(join(templater, 'manifest.json'), 'utf8'));
		assert.equal(templateManifest.id, 'templater-obsidian');
		const destination = join(config, 'plugins', templateManifest.id);
		await mkdir(destination);
		for (const file of ['main.js', 'manifest.json', 'styles.css'])
			await copyFile(join(templater, file), join(destination, file));
		ids.push(templateManifest.id);
	}
	await json(join(config, 'community-plugins.json'), ids);
	await json(join(installed, 'data.json'), { language: 'en', defaults: {}, registeredLibraries: libraries });
	await json(join(profile, 'obsidian.json'), {
		language: 'en',
		updateDisabled: true,
		vaults: { '109ec2a1ec27928f': { path: vault, open: true, ts: 1 } },
	});
	await writeFile(join(run, 'isolated.gitconfig'), '');
	return { run, vault, profile, temp, config, installed, manifest };
}

async function connect(url) {
	const socket = new WebSocket(url);
	const pending = new Map();
	const errors = [];
	let sequence = 0;
	socket.addEventListener('message', event => {
		const reply = JSON.parse(event.data);
		pending.get(reply.id)?.resolve(reply);
		if (reply.method === 'Runtime.exceptionThrown') errors.push(reply.params.exceptionDetails);
		if (reply.method === 'Runtime.consoleAPICalled' && reply.params.type === 'error')
			errors.push(reply.params.args.map(arg => arg.description ?? arg.value));
	});
	socket.addEventListener('close', () => {
		for (const request of pending.values()) request.reject(new Error('Closed Obsidian debugger'));
	});
	await new Promise((resolve, reject) => {
		const timer = deadlineTimer(() => reject(new Error('Obsidian debugger connection timed out')), 5000);
		socket.addEventListener('open', () => { cancelDeadline(timer); resolve(); }, { once: true });
		socket.addEventListener('error', () => { cancelDeadline(timer); reject(new Error('Obsidian debugger connection failed')); }, { once: true });
	});
	async function call(method, params = {}) {
		const id = ++sequence;
		let timer;
		try {
			const reply = await new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				timer = deadlineTimer(() => reject(new Error('Debugger timed out on ' + method)), 45000);
				socket.send(JSON.stringify({ id, method, params }));
			});
			if (reply.error) throw new Error(JSON.stringify(reply.error));
			return reply.result;
		} finally {
			cancelDeadline(timer);
			pending.delete(id);
		}
	}
	async function evaluate(fn, ...args) {
		const response = await call('Runtime.evaluate', {
			expression: `(${fn})(...${JSON.stringify(args)})`,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		});
		if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
		return response.result.value;
	}
	return { call, evaluate, errors, disconnect: () => socket.close() };
}

export async function launchDesktop(fixture, executable, receipt = 'process') {
	assert.equal(process.platform, 'win32', 'This runner targets the Windows Obsidian installer');
	const path = resolve(executable);
	assert((await stat(path)).isFile(), 'Missing local Obsidian executable');
	const portFile = join(fixture.profile, 'DevToolsActivePort');
	await unlink(portFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
	const started = Date.now();
	const child = spawn(path, [
		'--user-data-dir=' + fixture.profile,
		'--remote-debugging-port=0',
		'--remote-debugging-address=127.0.0.1',
		'--disable-background-networking',
		'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
		'--proxy-server=http://127.0.0.1:9',
	], {
		cwd: fixture.run,
		stderr: 'pipe',
		stdout: 'pipe',
		windowsHide: true,
		env: {
			...process.env,
			TEMP: fixture.temp, TMP: fixture.temp,
			GIT_CONFIG_GLOBAL: join(fixture.run, 'isolated.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
			GIT_TERMINAL_PROMPT: '0',
		},
	});
	let failure;
	let output = '';
	child.on('error', error => { failure = error; });
	for (const stream of [child.stderr, child.stdout]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-24000); });
	await json(join(fixture.run, receipt + '.json'), {
		pid: child.pid, startedAt: new Date(started).toISOString(), executable: path, profile: fixture.profile,
	});
	let session;
	let verified = false;
	let http;
	let childExited = false;
	const exited = new Promise(resolve => child.once('exit', (code, signal) => { childExited = true; resolve({ code, signal }); }));
	const verifyDebuggerUrl = address => {
		const url = new URL(address);
		assert.equal(url.origin, http.replace('http:', 'ws:'), 'Refusing a debugger outside the instance loopback port');
		return url.href;
	};
	async function readDebugger(endpoint) {
		const response = await new Promise((resolve, reject) => {
			get(http + endpoint, { signal: AbortSignal.timeout(2000) }, resolve).once('error', reject);
		});
		response.setEncoding('utf8');
		let body = '';
		for await (const chunk of response) body += chunk;
		return JSON.parse(body);
	}
	async function close() {
		try {
			if (verified && !childExited) {
				const browser = await readDebugger('/json/version');
				const control = await connect(verifyDebuggerUrl(browser.webSocketDebuggerUrl));
				try { await control.call('Browser.close'); }
				catch (error) { if (!/Closed Obsidian debugger/u.test(String(error))) throw error; }
				finally { control.disconnect(); }
			}
		} finally {
			session?.disconnect();
			if (child.pid && !childExited && !await Promise.race([exited, pause(4000, null)])) child.kill();
			if (child.pid && !childExited) await Promise.race([exited, pause(4000)]);
			await writeFile(join(fixture.run, receipt + '-output.log'), output);
			await json(join(fixture.run, receipt + '-exit.json'), { pid: child.pid, exited: childExited, code: child.exitCode });
		}
	}
	try {
		const port = await until(async () => {
			if (failure) throw failure;
			if (childExited) throw new Error('Obsidian exited before debugger startup');
			const data = await readFile(portFile, 'utf8').catch(() => '');
			return /^\d{1,5}(?=\r?\n)/u.exec(data)?.[0];
		}, 'the isolated profile debugger', 25000);
		http = 'http://127.0.0.1:' + port;
		const list = () => readDebugger('/json/list');
		const page = await until(async () => {
			const pages = await list().catch(() => []);
			return pages.find(page => page.type === 'page' && page.url === 'app://obsidian.md/index.html');
		}, 'isolated Obsidian renderer', 25000);
		session = await connect(verifyDebuggerUrl(page.webSocketDebuggerUrl));
		await session.call('Runtime.enable');
		const loaded = await until(async () => {
			if (childExited) throw new Error('Obsidian exited before the vault loaded');
			try { return await session.evaluate(() => window.app?.vault?.adapter?.getBasePath?.()); }
			catch { return undefined; }
		}, 'renderer Vault identity', 25000);
		const actual = await realpath(loaded);
		assert.equal(actual, fixture.vault, 'Refusing to operate on a different vault');
		assert(isAbsolute(actual) && !relative(fixture.run, actual).startsWith('..' + sep));
		verified = true;
		const version = await readDebugger('/json/version');
		return {
			...session, close, list, browser: version.Browser, pid: child.pid, started,
			connectPage: page => connect(verifyDebuggerUrl(page.webSocketDebuggerUrl)),
		};
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
}

export async function trustFixture(desktop) {
	await until(() => desktop.evaluate(id => {
		if (window.app.plugins.plugins[id]) return true;
		const trust = [...document.querySelectorAll('.modal.mod-trust-folder button')]
			.find(button => /^(Trust author and enable plugins|信任仓库作者并启用插件)$/iu.test(button.textContent.trim()));
		if (trust && !window.kbFixtureTrustClicked) {
			window.kbFixtureTrustClicked = true;
			trust.click();
		}
	}, pluginId), 'synthetic Vault trust dialog and plugin load');
	await desktop.evaluate(() => { window.app.setting.close(); });
}
