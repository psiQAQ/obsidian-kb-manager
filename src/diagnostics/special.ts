import {execFile, spawn} from 'node:child_process';
import type {ChildProcessByStdio} from 'node:child_process';
import * as path from 'node:path';
import type {Readable, Writable} from 'node:stream';
import {clearTimeout, setTimeout} from 'node:timers';
import {findLocalExecutable} from '../fs/local-executable.ts';
import {tr} from '../i18n.ts';
import {readCheckedItems, recordChecked} from './checked-items.ts';
import {commonToolsSource} from './common-tools.ts';
import {addReason, reportUnreadableDirectories, reportUnreadableNotes} from './coverage.ts';
import {relativePath} from './snapshot.ts';
import type {DeclaredCheck, Inventory} from './snapshot.ts';
import {isRecord, printable, result, settle} from './types.ts';
import type {CheckContext, Diagnostic, DiagnosticOptions} from './types.ts';

const outputLimit = 512 * 1024;
const childSource = String.raw`
import {readFileSync, writeSync} from 'node:fs';
${commonToolsSource}
function reply(value) {
	const bytes = Buffer.from(JSON.stringify(value));
	for (let offset = 0; offset < bytes.length;) offset += writeSync(3, bytes, offset, bytes.length - offset);
}
function limitTemplateDetails(result) {
	if (!Array.isArray(result?.checkedItems)) return result;
	const rows = result.checkedItems;
	const checkedItemCount = rows.reduce((total, row) => {
		const count = row?.count === undefined ? 1 : row.count;
		return Number.isSafeInteger(count) && count > 0 ? total + count : NaN;
	}, 0);
	const summary = {...result, checkedItemCount, checkedItems:[]};
	// Preserve diagnostics and the total under the separate check-process output limit.
	let remaining = Math.min(256 * 1024, ${outputLimit} - Buffer.byteLength(JSON.stringify({result:summary})));
	for (const row of rows) {
		if (summary.checkedItems.length >= 4000) break;
		remaining -= Buffer.byteLength(JSON.stringify(row) ?? 'null') + 1;
		if (remaining < 0) break;
		summary.checkedItems.push(row);
	}
	return summary;
}
try {
	const {source, context, chinese} = JSON.parse(readFileSync(0, 'utf8'));
	const moduleUrl = 'data:text/javascript;base64,' + source;
	const {default: check} = await import(moduleUrl);
	if (typeof check !== 'function') reply({error:'checker-export'});
	else reply({result:chinese === undefined ? limitTemplateDetails(await check(context)) : await check(context, commonTools(chinese))});
} catch {reply({error:'checker-execution'});}
`;
const inputLimit = 32 * 1024 * 1024;
const windows = process.platform === 'win32';

type ChildResult = {error: string} | {data: unknown};
async function stopChecker(child: ChildProcessByStdio<Writable, Readable, Readable>) {
	const {pid} = child;
	if (!pid) return;
	if (windows) {
		const system = process.env.SystemRoot || process.env.WINDIR;
		if (system && path.isAbsolute(system)) {
			const stopped = await new Promise<boolean>(resolve => {
				execFile(path.join(system,'System32','taskkill.exe'), ['/pid',String(pid),'/t','/f'],
					{windowsHide:true, timeout:5000}, error => resolve(!error));
			});
			if (stopped) return;
		}
	} else {
		try {process.kill(-pid, 'SIGKILL'); return;}
		catch (error) {if (!isRecord(error) || error.code !== 'ESRCH') throw error;}
	}
	child.kill('SIGKILL');
}

function execute(node: string, input: string, timeout: number, maxOutput: number, signal?: AbortSignal): Promise<ChildResult> {
	return new Promise(resolve => {
		signal?.throwIfAborted();
		const env: NodeJS.ProcessEnv = {};
		for (const name of ['SystemRoot','WINDIR']) if (process.env[name]) env[name] = process.env[name];
		let child: ChildProcessByStdio<Writable, Readable, Readable>;
		try {
			child = spawn(node, ['--max-old-space-size=128','--input-type=module','--eval',childSource], {
				cwd: path.dirname(node), env, stdio: ['pipe','pipe','pipe','pipe'], windowsHide: true, shell: false, detached: !windows,
			});
		} catch {resolve({error: 'checker-launch'}); return;}
		const channel = child.stdio[3] as Readable;
		const parts: Buffer[] = [];
		let bytes = 0;
		let stopped: string | undefined;
		let termination: Promise<void> | undefined;
		const timer = setTimeout(() => stop('checker-timeout'), timeout);
		const abort = () => stop('checker-cancelled');
		signal?.addEventListener('abort', abort, {once:true});
		function stop(error: string) {
			if (stopped) return;
			stopped = error;
			clearTimeout(timer);
			termination = stopChecker(child).catch(() => {child.kill('SIGKILL');});
			child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); channel.destroy();
		}
		function count(chunk: Buffer) {
			bytes += chunk.length;
			if (bytes > maxOutput) stop('checker-output-limit');
		}
		child.stdout.on('data', count);
		child.stderr.on('data', count);
		channel.on('data', (chunk: Buffer) => {count(chunk); if (!stopped) parts.push(chunk);});
		for (const stream of [child.stdout, child.stderr, channel]) stream.on('error', () => stop('checker-transport'));
		child.once('error', () => stop('checker-launch'));
		child.once('close', code => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (stopped || code !== 0) {
				const failure = {error:stopped ?? 'checker-execution'};
				void Promise.resolve(termination).then(() => resolve(failure));
				return;
			}
			try {
				const response: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
				if (!isRecord(response)) {resolve({error: 'checker-output'}); return;}
				if (response.error === 'checker-export' || response.error === 'checker-execution') resolve({error: response.error});
				else resolve({data: response.result});
			} catch {resolve({error: 'checker-output'});}
		});
		child.stdin.on('error', () => {/* The child may have exited before consuming input. */});
		child.stdin.end(input);
	});
}

export async function runChecker(source: Buffer, options: DiagnosticOptions, vault: string,
	readContext: () => Promise<unknown>, common = false): Promise<ChildResult> {
	const {signal} = options;
	signal?.throwIfAborted();
	const node = await findLocalExecutable('node', [options.vaultRoot, vault], options.nodeExecutable);
	signal?.throwIfAborted();
	if (!node) return {error:'checker-node'};
	const context = await readContext();
	signal?.throwIfAborted();
	const input = JSON.stringify({source:source.toString('base64'), context, chinese:common ? tr('1','0') === '1' : undefined});
	if (Buffer.byteLength(input) > inputLimit) return {error:'checker-input-limit'};
	const response = await execute(node, input, Math.max(1, Math.min(options.timeoutMs ?? 10000, 60000)), common ? 4 * 1024 * 1024 : outputLimit, signal);
	signal?.throwIfAborted();
	return response;
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
			(row.column !== undefined && (row.line === undefined || typeof row.column !== 'number' || !Number.isSafeInteger(row.column) || row.column < 1)) ||
			(row.field !== undefined && !printable(row.field, 512)) ||
			(row.evidence !== undefined && !printable(row.evidence, common ? 100000 : 1000))) return;
		diagnostics.push({severity: row.severity, code: row.code, message: row.message, file: row.file, line: row.line, evidence: row.evidence,
			...(row.column !== undefined && {column:row.column}), ...(row.field !== undefined && {field:row.field})});
	}
	return diagnostics;
}

export function specialCheckTrusted(check: DeclaredCheck, options: DiagnosticOptions) {
	const {digest} = check;
	return !!digest && (options.officialDigests?.includes(digest) || options.trustedDigests?.includes(digest));
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
	if (!specialCheckTrusted(check, options)) return fail('checker-untrusted');
	const response = await runChecker(check.source, options, vault, async () => check.linkEvidence ? {...context, links:await readLinks()} : context);
	if ('error' in response) return fail(response.error);
	const output = isRecord(response.data) ? response.data : {findings: response.data, unverified: 0};
	const {unverified = 0} = output;
	const findings = readFindings(output.findings);
	if (!findings || typeof unverified !== 'number' || !Number.isSafeInteger(unverified) || unverified < 0 || unverified > 5000)
		return fail('checker-output');
	if (output.checkedItems !== undefined) {
		const items = readCheckedItems(output.checkedItems);
		const total = output.checkedItemCount;
		if (!items || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return fail('checker-output');
		const visible = items.reduce((count,item) => count + (item.count ?? 1),0);
		if (total < visible) return fail('checker-output');
		report.checkedItems = items;
		report.coverage.checked = total;
		if (total > visible) addReason(report, tr(
			`明细达到输出上限，已显示 ${visible} 项，共检查 ${total} 项。`,
			`The detail limit was reached. Showing ${visible} of ${total} checked items.`));
		if (!total && !unverified && !findings.length)
			recordChecked(report,check.path,tr('专项的适用范围','Template check scope'),
				tr('脚本执行完毕，返回空的已检明细。','The script completed and returned no checked items.'));
	} else {
		recordChecked(report,check.path,tr('专项脚本运行','Template check execution'),tr(
			`脚本返回 ${findings.length} 条发现和 ${unverified} 项待核实，没有提供逐项检验明细。`,
			`The script returned ${findings.length} findings and ${unverified} unverified items without item-level details.`));
	}
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
