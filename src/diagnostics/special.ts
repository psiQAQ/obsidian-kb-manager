import {spawn} from 'node:child_process';
import type {ChildProcessByStdio} from 'node:child_process';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {Readable, Writable} from 'node:stream';
import {clearTimeout, setTimeout} from 'node:timers';
import {tr} from '../i18n.ts';
import {relativePath} from './snapshot.ts';
import type {DeclaredCheck} from './snapshot.ts';
import {isRecord, printable, result, settle} from './types.ts';
import type {CheckContext, Diagnostic, DiagnosticOptions} from './types.ts';

const childSource = String.raw`
import {readFileSync, writeSync} from 'node:fs';
function reply(value) {
	const bytes = Buffer.from(JSON.stringify(value));
	for (let offset = 0; offset < bytes.length;) offset += writeSync(3, bytes, offset, bytes.length - offset);
}
try {
	const {source, context} = JSON.parse(readFileSync(0, 'utf8'));
	const moduleUrl = 'data:text/javascript;base64,' + source;
	const {default: check} = await import(moduleUrl);
	if (typeof check !== 'function') reply({error:'checker-export'});
	else reply({result:await check(context)});
} catch {reply({error:'checker-execution'});}
`;
const outputLimit = 512 * 1024;
const inputLimit = 32 * 1024 * 1024;

function inside(folder: string, filename: string) {
	const relative = path.relative(folder, filename);
	return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function findNode(vault: string, override?: string): Promise<string | undefined> {
	const name = process.platform === 'win32' ? 'node.exe' : 'node';
	const search = override ? [override] : (process.env.PATH ?? '').split(path.delimiter)
		.map(dir => dir.replace(/^"|"$/gu, '')).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, name));
	for (const candidate of search) {
		if (!path.isAbsolute(candidate) || inside(vault, candidate)) continue;
		try {
			const real = await fs.realpath(candidate);
			if (inside(vault, real) || !(await fs.stat(real)).isFile()) continue;
			await fs.access(real, constants.X_OK);
			return real;
		} catch {/* Try the next absolute executable path. */}
	}
	return undefined;
}

type ChildResult = {error: string} | {data: unknown};
function execute(node: string, input: string, timeout: number): Promise<ChildResult> {
	return new Promise(resolve => {
		const env: NodeJS.ProcessEnv = {};
		for (const name of ['SystemRoot','WINDIR']) if (process.env[name]) env[name] = process.env[name];
		let child: ChildProcessByStdio<Writable, Readable, Readable>;
		try {
			child = spawn(node, ['--max-old-space-size=128','--input-type=module','--eval',childSource], {
				cwd: path.dirname(node), env, stdio: ['pipe','pipe','pipe','pipe'], windowsHide: true, shell: false,
			});
		} catch {resolve({error: 'checker-launch'}); return;}
		const channel = child.stdio[3] as Readable;
		const parts: Buffer[] = [];
		let bytes = 0, finished = false;
		const timer = setTimeout(() => stop('checker-timeout'), timeout);
		function finish(value: ChildResult) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve(value);
		}
		function stop(error: string) {
			if (finished) return;
			finish({error});
			child.kill('SIGKILL');
			child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); channel.destroy();
		}
		function count(chunk: Buffer) {
			bytes += chunk.length;
			if (bytes > outputLimit) stop('checker-output-limit');
		}
		child.stdout.on('data', count);
		child.stderr.on('data', count);
		channel.on('data', (chunk: Buffer) => {count(chunk); if (!finished) parts.push(chunk);});
		for (const stream of [child.stdout, child.stderr, channel]) stream.on('error', () => stop('checker-transport'));
		child.once('error', () => stop('checker-launch'));
		child.once('close', code => {
			if (finished) return;
			if (code !== 0) {finish({error: 'checker-execution'}); return;}
			try {
				const response: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
				if (!isRecord(response)) {finish({error: 'checker-output'}); return;}
				if (response.error === 'checker-export' || response.error === 'checker-execution') finish({error: response.error});
				else finish({data: response.result});
			} catch {finish({error: 'checker-output'});}
		});
		child.stdin.on('error', () => {/* The child may have exited before consuming input. */});
		child.stdin.end(input);
	});
}

const errors: Record<string, readonly [string, string]> = {
	'checker-untrusted': ['专项脚本需要批准当前文件摘要。','Review the script and approve its current fingerprint before running it.'],
	'checker-unavailable': ['专项脚本不可读或不符合要求。','Check that the script is a readable, standalone UTF-8 file.'],
	'checker-config': ['专项检查需要有效的知识库与模板清单。','Check the library and template manifests before running this script.'],
	'checker-node': ['找不到 Vault 外有效的本机 Node.js 可执行文件。','Node.js was not found. Check that the system Node.js executable is on PATH and outside the vault.'],
	'checker-timeout': ['专项检查超时。','The template check timed out. Review the script for slow or nonterminating work.'],
	'checker-output-limit': ['专项的输出超过大小限制。','The template check produced too much output. Reduce its findings or console output.'],
	'checker-input-limit': ['专项输入超过大小限制。','The template check input exceeded the size limit.'],
	'checker-transport': ['专项进程通信失败。','Could not communicate with the template check process.'],
	'checker-launch': ['无法启动专项进程。','Could not start the template check process.'],
	'checker-execution': ['专项脚本执行时抛出异常或退出。','The script threw an exception or exited. Review the script before retrying.'],
	'checker-export': ['专项脚本须默认导出检查函数。','Export the check function as the script’s default export.'],
	'checker-output': ['专项脚本须返回符合诊断协议的数组。','Return an array of findings that follows the diagnostic format.'],
};

function readFindings(data: unknown): Diagnostic[] | undefined {
	if (!Array.isArray(data) || data.length > 5000) return;
	const diagnostics: Diagnostic[] = [];
	for (const row of data as unknown[]) {
		if (!isRecord(row) || (row.severity !== 'error' && row.severity !== 'warning' && row.severity !== 'info') ||
			typeof row.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/u.test(row.code) || !printable(row.message, 1000) ||
			(row.file !== undefined && !relativePath(row.file)) ||
			(row.line !== undefined && (typeof row.line !== 'number' || !Number.isSafeInteger(row.line) || row.line < 1)) ||
			(row.evidence !== undefined && !printable(row.evidence, 1000))) return;
		diagnostics.push({severity: row.severity, code: row.code, message: row.message, file: row.file, line: row.line, evidence: row.evidence});
	}
	return diagnostics;
}

export async function runSpecial(check: DeclaredCheck, options: DiagnosticOptions, vault: string, context: CheckContext | undefined, omitted: number, identifiedVault: boolean) {
	const report = result({id: check.id, name: check.name});
	function fail(code: string) {
		report.status = code === 'checker-untrusted' ? 'skipped' : 'failed';
		report.coverage[report.status === 'skipped' ? 'skipped' : 'unknown']++;
		const message = tr(...(errors[code] ?? errors['checker-output']!));
		report.reason = message;
		report.diagnostics.push({severity: report.status === 'skipped' ? 'info' : 'error', code, file: check.path, message});
		return report;
	}
	if (!check.source || !check.digest) return fail('checker-unavailable');
	if (!context) return fail('checker-config');
	if (![...options.officialDigests ?? [], ...options.trustedDigests ?? []].includes(check.digest)) return fail('checker-untrusted');
	const node = await findNode(vault, options.nodeExecutable);
	if (!node) return fail('checker-node');
	const input = JSON.stringify({source: check.source.toString('base64'), context});
	if (Buffer.byteLength(input) > inputLimit) return fail('checker-input-limit');
	const response = await execute(node, input, Math.max(1, Math.min(options.timeoutMs ?? 10000, 60000)));
	if ('error' in response) return fail(response.error);
	const findings = readFindings(response.data);
	if (!findings) return fail('checker-output');
	report.coverage.checked = 1;
	report.coverage.unknown = omitted + (identifiedVault ? 0 : 1);
	const reasons = [omitted ? tr('部分笔记不可读或属性无效，未提供给专项脚本。','Notes that were unreadable or had invalid properties were omitted from the script input.') : '',
		identifiedVault ? '' : tr('未找到 Vault 根目录，无法确认专项使用的 Vault 相对路径。','The vault root is unknown. Provide it to verify vault-relative paths used by the script.')];
	report.reason = reasons.filter(Boolean).join(' ') || undefined;
	report.diagnostics = findings;
	return settle(report);
}
