import {spawn} from 'node:child_process';
import type {ChildProcessByStdio} from 'node:child_process';
import * as path from 'node:path';
import type {Readable, Writable} from 'node:stream';
import {clearTimeout, setTimeout} from 'node:timers';
import {findLocalExecutable} from '../fs/local-executable.ts';
import {tr} from '../i18n.ts';
import {commonToolsSource} from './common-tools.ts';
import {addReason, reportUnreadableDirectories, reportUnreadableNotes} from './coverage.ts';
import {relativePath} from './snapshot.ts';
import type {DeclaredCheck, Inventory} from './snapshot.ts';
import {isRecord, printable, result, settle} from './types.ts';
import type {CheckContext, Diagnostic, DiagnosticOptions} from './types.ts';

const childSource = String.raw`
import {readFileSync, writeSync} from 'node:fs';
${commonToolsSource}
function reply(value) {
	const bytes = Buffer.from(JSON.stringify(value));
	for (let offset = 0; offset < bytes.length;) offset += writeSync(3, bytes, offset, bytes.length - offset);
}
try {
	const {source, context, chinese} = JSON.parse(readFileSync(0, 'utf8'));
	const moduleUrl = 'data:text/javascript;base64,' + source;
	const {default: check} = await import(moduleUrl);
	if (typeof check !== 'function') reply({error:'checker-export'});
	else reply({result:chinese === undefined ? await check(context) : await check(context, commonTools(chinese))});
} catch {reply({error:'checker-execution'});}
`;
const outputLimit = 512 * 1024;
const inputLimit = 32 * 1024 * 1024;

type ChildResult = {error: string} | {data: unknown};
function execute(node: string, input: string, timeout: number, maxOutput: number): Promise<ChildResult> {
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
			if (bytes > maxOutput) stop('checker-output-limit');
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

export async function runChecker(source: Buffer, options: DiagnosticOptions, vault: string,
	readContext: () => Promise<unknown>, common = false): Promise<ChildResult> {
	const node = await findLocalExecutable('node', [options.vaultRoot, vault], options.nodeExecutable);
	if (!node) return {error:'checker-node'};
	const context = await readContext();
	const input = JSON.stringify({source:source.toString('base64'), context, chinese:common ? tr('1','0') === '1' : undefined});
	if (Buffer.byteLength(input) > inputLimit) return {error:'checker-input-limit'};
	return execute(node, input, Math.max(1, Math.min(options.timeoutMs ?? 10000, 60000)), common ? 4 * 1024 * 1024 : outputLimit);
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
	'checker-output': ['专项脚本返回的结果不符合诊断协议。','Return findings and coverage in the documented format.'],
};

export function readFindings(data: unknown, common = false): Diagnostic[] | undefined {
	if (!Array.isArray(data) || data.length > (common ? 25000 : 5000)) return;
	const diagnostics: Diagnostic[] = [];
	for (const row of data as unknown[]) {
		if (!isRecord(row) || (row.severity !== 'error' && row.severity !== 'warning' && row.severity !== 'info') ||
			typeof row.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/u.test(row.code) || !printable(row.message, 1000) ||
			(row.file !== undefined && !relativePath(row.file)) ||
			(row.line !== undefined && (typeof row.line !== 'number' || !Number.isSafeInteger(row.line) || row.line < 1)) ||
			(row.evidence !== undefined && !printable(row.evidence, common ? 100000 : 1000))) return;
		diagnostics.push({severity: row.severity, code: row.code, message: row.message, file: row.file, line: row.line, evidence: row.evidence});
	}
	return diagnostics;
}

export async function runSpecial(check: DeclaredCheck, options: DiagnosticOptions, vault: string, context: CheckContext | undefined,
	inventory: Inventory, identifiedVault: boolean, readLinks: () => Promise<NonNullable<CheckContext['links']>>) {
	const report = result({id: check.id, name: check.name});
	function fail(code: string) {
		report.status = code === 'checker-untrusted' ? 'partial' : 'failed';
		report.coverage.unknown++;
		const message = tr(...(errors[code] ?? errors['checker-output']!));
		report.reason = message;
		report.diagnostics.push({severity: report.status === 'partial' ? 'info' : 'error', code, file: check.path, message});
		return report;
	}
	if (!check.source || !check.digest) return fail('checker-unavailable');
	if (!context) return fail('checker-config');
	if (![...options.officialDigests ?? [], ...options.trustedDigests ?? []].includes(check.digest)) return fail('checker-untrusted');
	const response = await runChecker(check.source, options, vault, async () => check.linkEvidence ? {...context, links:await readLinks()} : context);
	if ('error' in response) return fail(response.error);
	const output = isRecord(response.data) ? response.data : {findings: response.data, unverified: 0};
	const {unverified = 0} = output;
	const findings = readFindings(output.findings);
	if (!findings || typeof unverified !== 'number' || !Number.isSafeInteger(unverified) || unverified < 0 || unverified > 5000)
		return fail('checker-output');
	report.coverage.checked = 1;
	report.coverage.unknown = (identifiedVault ? 0 : 1) + unverified;
	report.diagnostics = findings;
	reportUnreadableDirectories(report, inventory);
	reportUnreadableNotes(report, inventory);
	for (const note of inventory.notes) {
		if (!note.problem) continue;
		report.coverage.unknown++;
		const message = tr('无法解析笔记属性，专项脚本未收到这篇笔记。','The script did not receive this note because its frontmatter could not be parsed.');
		report.diagnostics.push({severity:'info', code:'checker-input-invalid-properties', file:note.path, line:note.problem.line, message});
		addReason(report, tr('部分笔记的属性无法解析，已从专项输入省略。','Notes with unparseable frontmatter were omitted from the script input.'));
	}
	if (!identifiedVault)
		addReason(report, tr('未找到 Vault 根目录，无法确认专项使用的 Vault 相对路径。','The vault root is unknown. Provide it to verify vault-relative paths used by the script.'));
	if (unverified)
		addReason(report, tr('专项检查有待核实的项目。','The template check has items that could not be verified.'));
	return settle(report);
}
