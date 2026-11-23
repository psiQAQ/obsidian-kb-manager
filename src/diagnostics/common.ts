import {tr} from '../i18n.ts';
import {readCheckedItems} from './checked-items.ts';
import {bundledCommonRule, runBundledCommon} from './bundled-common.ts';
import {entryVersion, libraryLocation, manifestSnapshot, readChecker, relativeEntry, unavailableVersion} from './snapshot.ts';
import type {InputTrace} from './provenance.ts';
import type {DeclaredCheck} from './snapshot.ts';
import {readFindings, runChecker} from './special.ts';
import {generalChecks, isRecord, portabilityCheck, printable} from './types.ts';
import type {Coverage, DiagnosticCheckResult, DiagnosticOptions, SpecialCheck} from './types.ts';

const invalidKit = () => tr('通用规则清单无效。请检查 kb.toml 中的 [checkKit]。','The check kit declaration is invalid. Review [checkKit] in kb.toml.');
const unavailable = () => tr('通用规则缺失或不可读。','The common rule file is missing or unreadable.');
const commonRules = [...generalChecks, portabilityCheck];
const rulePath = (id: string) => `checks/common/${id}.mjs`;
type KitDeclaration = Awaited<ReturnType<typeof manifestSnapshot>>['checkKit'];

async function localKit(root: string, signal?: AbortSignal, trace?: InputTrace) {
	// A plain Git checkout has tracked rule files but may not have a private kb.toml.
	const stat = async (file: string) => {
		try {
			const {stat} = await relativeEntry(root,file,signal);
			trace?.file(file,entryVersion(stat));
			return stat;
		} catch (error) {
			signal?.throwIfAborted();
			trace?.file(file,unavailableVersion(error));
			return undefined;
		}
	};
	if (!(await stat('checks'))?.isDirectory() || !(await stat('checks/kb-check.cjs'))?.isFile() || !(await stat('checks/common'))?.isDirectory()) return false;
	for (const {id} of commonRules) if (await stat(rulePath(id))) return true;
	return false;
}

export async function commonSnapshot(root: string, kit: KitDeclaration, selected?: readonly string[], signal?: AbortSignal, trace?: InputTrace) {
	if (kit === undefined && !await localKit(root, signal, trace)) return;
	const checks: DeclaredCheck[] = [];
	for (const rule of commonRules) {
		signal?.throwIfAborted();
		if (selected && !selected.includes(rule.id)) continue;
		const check: DeclaredCheck = {...rule, path:rulePath(rule.id)};
		checks.push(check);
		if (kit === null) {check.reason = invalidKit(); continue;}
		if (kit && !Object.prototype.hasOwnProperty.call(kit.digests, check.path)) {check.reason = unavailable(); continue;}
		try {
			const {source, digest} = await readChecker(root, check.path, signal, trace);
			check.source = source;
			check.digest = digest;
		} catch {signal?.throwIfAborted(); check.reason = unavailable();}
	}
	return checks;
}

export async function listCommonChecks(libraryRoot: string, signal?: AbortSignal): Promise<{mode:'legacy'|'kit'; checks:SpecialCheck[]; reason?:string}> {
	try {
		const {root} = await libraryLocation({libraryRoot,signal});
		const {checkKit} = await manifestSnapshot(root, signal);
		const checks = await commonSnapshot(root, checkKit, undefined, signal);
		if (!checks) return {mode:'legacy', checks:[]};
		return {mode:'kit', checks:checks.map(({id,name,path,digest,reason}) => ({id,name,path,digest,reason})), reason:checkKit === null ? invalidKit() : undefined};
	} catch {signal?.throwIfAborted(); return {mode:'kit', checks:[], reason:unavailable()};}
}

export async function readDiagnosticScript(libraryRoot: string, scriptPath: string) {
	if (!/^checks\/(?:common\/)?[^/]+\.mjs$/u.test(scriptPath)) throw new Error('invalid-check-script-path');
	const {root} = await libraryLocation({libraryRoot});
	const {text, digest} = await readChecker(root, scriptPath);
	return {source:text, digest};
}

export function commonCheckTrusted(check: SpecialCheck, trustedDigests: readonly string[] = []) {
	const {digest} = check;
	return !!digest && (!!bundledCommonRule(check) || trustedDigests.includes(digest));
}

function failure(check: DiagnosticCheckResult, path: string, code: string, message: string) {
	check.status = code === 'checker-untrusted' ? 'partial' : 'failed';
	check.coverage.unknown++;
	check.reason = message;
	check.diagnostics.push({severity:check.status === 'partial' ? 'info' : 'error', code, file:path, message});
	return check;
}

function readCoverage(value: unknown): Coverage | undefined {
	if (!isRecord(value)) return;
	const {checked, skipped, unknown} = value;
	const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
	if (isCount(checked) && isCount(skipped) && isCount(unknown)) return {checked, skipped, unknown};
	return undefined;
}

export async function runCommon(rule: DeclaredCheck, result: DiagnosticCheckResult, options: DiagnosticOptions, vault: string,
	readContext: () => Promise<unknown>) {
	const fail = (code: string, message: string) => failure(result, rule.path, code, message);
	if (!rule.source || !rule.digest) return fail('checker-unavailable', rule.reason ?? unavailable());
	if (!commonCheckTrusted(rule, options.trustedDigests))
		return fail('checker-untrusted', tr('运行前请审查并认可通用规则的当前摘要。','Review and approve the common rule’s current fingerprint before running it.'));
	const bundled = bundledCommonRule(rule);
	const response = bundled ? await runBundledCommon(bundled,readContext,options.signal) : await runChecker(rule.source, options, vault, readContext, true);
	if ('error' in response) {
		const message = response.error === 'checker-node'
			? tr('找不到 Vault 外有效的本机 Node.js。','Node.js was not found outside the vault.')
			: tr('通用规则运行失败','Could not run the common rule') + ` (${response.error}).`;
		return fail(response.error, message);
	}
	const invalidResult = () => fail('checker-output', tr('通用规则返回的结果不符合协议。','Return findings and coverage in the documented common rule format.'));
	if (!isRecord(response.data)) return invalidResult();
	const {diagnostics, coverage, reason} = response.data;
	const findings = readFindings(diagnostics, true);
	const counts = readCoverage(coverage);
	if (!findings || !counts || (reason !== undefined && !printable(reason, 100000))) return invalidResult();
	if (!bundled && response.data.checkedItems !== undefined) {
		const items = readCheckedItems(response.data.checkedItems);
		if (!items || items.reduce((n,item)=>n+(item.count ?? 1),0) > counts.checked) return invalidResult();
		result.checkedItems = items;
	}
	result.coverage = counts;
	result.diagnostics = findings;
	result.reason = reason;
	return result;
}
