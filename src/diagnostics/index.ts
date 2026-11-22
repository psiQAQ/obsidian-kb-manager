import {randomUUID} from 'node:crypto';
import {tr} from '../i18n.ts';
import {checkKitVersion} from '../kb/check-kit.ts';
import {diagnosticEngineVersion} from '../kb/common-rules.ts';
import checkBases from '../../assets/checks/common/bases.mjs';
import checkBindings from '../../assets/checks/common/bindings.mjs';
import {readBaseEvidence} from './base-evidence.ts';
import {bindingEvidence} from './binding-evidence.ts';
import {bundledCommonDigest, bundledCommonRule} from './bundled-common.ts';
import {collectCheckLinkEvidence} from './check-links.ts';
import {commonCheckTrusted, commonSnapshot, runCommon} from './common.ts';
import {commonEvidence} from './common-evidence.ts';
import {addReason, reportInventoryCoverage} from './coverage.ts';
import {saveDiagnosticReport} from './history.ts';
import {inspectLinks} from './links.ts';
import {traceDiagnosticInputs} from './provenance.ts';
import {checkContext, inventory, libraryLocation, manifestSnapshot, readSelectedTemplateScripts, templateSnapshot} from './snapshot.ts';
import {runSpecial, specialCheckTrusted} from './special.ts';
import {inspectCanvas, inspectManifest, inspectProperties} from './structures.ts';
import {generalChecks, generalIds, portabilityCheck, result, settle} from './types.ts';
import type {DiagnosticCheckResult, DiagnosticOptions, DiagnosticReport, DiagnosticRuleVersion, DiagnosticStatus, SpecialCheck, TemplateIdentity} from './types.ts';

export {generalChecks, portabilityCheck} from './types.ts';
export {baseViewStatus} from './base-view.ts';
export {commonCheckTrusted, listCommonChecks, readDiagnosticScript} from './common.ts';
export {listDiagnosticHistory} from './history.ts';
export {compareDiagnosticReports} from './comparison.ts';
export {diagnosticFreshness} from './provenance.ts';
export type * from './types.ts';

export async function listSpecialChecks(libraryRoot: string, signal?: AbortSignal): Promise<{template?: TemplateIdentity; checks: SpecialCheck[]; reason?: string}> {
	try {
		const {root} = await libraryLocation({libraryRoot, signal});
		const list = await templateSnapshot(root, true, signal);
		const template = list.template ? {id: list.template.id, version: list.template.version} : undefined;
		return {template, checks: list.checks.map(({id,name,path,description,digest,reason}) => ({id,name,path,description,digest,reason})),
			reason: list.reason ?? (list.missing ? tr('本库未配置模板专项检查。','This library has no template checks configured.') : undefined)};
	} catch {
		signal?.throwIfAborted();
		return {checks: [], reason: tr('无法访问知识库根目录。','Could not access the library folder.')};
	}
}

function aggregate(checks: DiagnosticCheckResult[]): DiagnosticStatus {
	if (checks.some(check => check.status === 'failed')) return 'failed';
	if (checks.some(check => check.status === 'partial')) return 'partial';
	if (checks.some(check => check.status === 'findings')) return 'findings';
	return checks.some(check => check.status === 'passed') ? 'passed' : 'skipped';
}

function failure(check: DiagnosticCheckResult, code: string, message: string) {
	check.status = 'failed';
	check.coverage.unknown++;
	check.reason = message;
	check.diagnostics.push({severity:'error', code, message});
	return check;
}

const markdownChecks = new Set(['properties','links','anchors','bases','portability']);

export async function runDiagnostics(options: DiagnosticOptions): Promise<DiagnosticReport> {
	const {signal, selected} = options;
	const all = !selected || selected === 'all';
	const names = new Map([...generalChecks, portabilityCheck].map(rule => [rule.id as string,rule.name]));
	const active = all ? generalChecks.map(item => item.id as string) : [...new Set(selected)];
	const listedTemplateChecks = options.knownTemplateChecks ?? [];
	for (const check of listedTemplateChecks) names.set(check.id,check.name);
	let readTemplate = false;
	const describe = (id: string) => ({id,name:names.get(id) ?? tr('专项检查','Template check')});
	const startedAt = new Date().toISOString();
	const report: DiagnosticReport = {schemaVersion:1, runId:randomUUID(), startedAt, finishedAt:startedAt,
		environment: options.resolveLink ? 'desktop' : 'offline', library:{}, status:'skipped', checks:[], engineVersion:diagnosticEngineVersion};
	const trace = traceDiagnosticInputs();
	let location: Awaited<ReturnType<typeof libraryLocation>> | undefined;
	try {
		const located = await libraryLocation(options);
		location = located;
		const {root, relative, vault, configDir, identifiedVault} = located;
		const needsScripts = all || selected.some(id => !generalIds.has(id));
		const template = await templateSnapshot(root, false, signal, trace);
		readTemplate = true;
		const specials = new Map(template.checks.map(check => [check.id,check]));
		for (const check of specials.values()) names.set(check.id,check.name);
		if (all) active.push(...specials.keys());
		if (needsScripts) await readSelectedTemplateScripts(root, template, active, signal, trace);
		const manifest = await manifestSnapshot(root, signal, trace);
		const identity = manifest.parsed?.identity;
		report.library = {id:identity?.id, template:template.template ? {id:template.template.id, version:template.template.version} : identity?.template};
		const dirs = new Set(template.template?.pageTemplates ?? []);
		if (manifest.parsed?.mapping?.templates) dirs.add(manifest.parsed.mapping.templates);
		const templateDirs = [...dirs];
		const checks = new Map(active.map(id => [id, result(describe(id))]));
		const common = await commonSnapshot(root,manifest.checkKit,active,signal,trace);
		const commonRules = new Map(common?.map(rule => [rule.id,rule]));
		function ruleVersion(id: string): DiagnosticRuleVersion | undefined {
			const commonRule = commonRules.get(id);
			const specialRule = specials.get(id);
			if (commonRule) {
				const digest = bundledCommonDigest(commonRule);
				const compatible = digest && digest !== commonRule.digest;
				return {engine:digest ? 'bundled' : 'node', version:compatible ? checkKitVersion : manifest.checkKit?.version ?? diagnosticEngineVersion,
					path:commonRule.path, digest:digest ?? commonRule.digest, ...(compatible && {sourceDigest:commonRule.digest})};
			}
			if (specialRule) return {engine:'node', version:template.template?.version ?? diagnosticEngineVersion,
				path:specialRule.path, digest:specialRule.digest};
			if (generalIds.has(id)) return {engine:'legacy', version:diagnosticEngineVersion};
			return undefined;
		}
		const availableGeneral = active.filter(id => {
			if (!generalIds.has(id)) return false;
			if (!common) return true;
			const rule = commonRules.get(id);
			return !!rule?.source && commonCheckTrusted(rule,options.trustedDigests);
		});
		const templateNeedsNotes = !!manifest.parsed && !!template.template && active.some(id => {
			const check = specials.get(id);
			return !!check?.source && specialCheckTrusted(check,options);
		});
		const needsNotes = templateNeedsNotes || availableGeneral.some(id => markdownChecks.has(id));
		const needsPaths = availableGeneral.includes('manifest') || availableGeneral.includes('canvas');
		const found = await inventory(root, configDir, needsNotes ? 'notes' : needsPaths ? 'paths' : 'none', signal, trace);
		let readCommonEvidence: ReturnType<typeof commonEvidence> | undefined;
		const linkOptions = {...options,vaultRoot:identifiedVault ? vault : undefined,trace};
		const completed = new Set<string>();
		const push = (check: DiagnosticCheckResult) => {
			signal?.throwIfAborted();
			completed.add(check.id);
			report.checks.push({...settle(check),rule:ruleVersion(check.id)});
		};
		if (!common) {
			const links = {links:checks.get('links'), anchors:checks.get('anchors'), portability:checks.get('portability')};
			if (links.portability && options.linkCandidateScope) {
				const scope = options.linkCandidateScope === 'vault'
					? tr('同名候选范围为整个 Vault。','Same-name candidates are checked across the vault.')
					: options.registeredPaths
						? tr('同名候选范围为当前库和已登记库。','Same-name candidates are checked in the current and registered libraries.')
						: tr('知识库登记不可用，同名候选只检查当前库。','The library registry is unavailable. Same-name candidates are checked in the current library.');
				addReason(links.portability, scope);
				if (options.linkCandidateScope === 'registered' && !options.registeredPaths) links.portability.coverage.unknown++;
			}
			if (Object.values(links).some(Boolean)) {
				try {await inspectLinks(linkOptions, found, root, relative, links);}
				catch {
					signal?.throwIfAborted();
					for (const check of Object.values(links)) if (check) failure(check, 'link-run-failed', tr('链接检查未能完成。','Could not complete the link check.'));
				}
				if (links.links) push(links.links);
				if (links.anchors) push(links.anchors);
			}
			const canvas = {canvas:checks.get('canvas'), portability:links.portability};
			if (canvas.canvas || canvas.portability) {
				try {await inspectCanvas(canvas, root, found, linkOptions, relative);}
				catch {
					signal?.throwIfAborted();
					for (const check of Object.values(canvas)) if (check) failure(check, 'canvas-run-failed', tr('Canvas 检查未能完成。','Could not complete the Canvas check.'));
				}
				for (const check of Object.values(canvas)) if (check) push(check);
			}
		}
		const context = needsScripts && template.template && manifest.parsed ? checkContext(relative,template.template,manifest,found.notes) : undefined;
		let linkEvidence: ReturnType<typeof collectCheckLinkEvidence> | undefined;
		const readLinks = () => linkEvidence ??= collectCheckLinkEvidence(linkOptions, found, root, relative);
		for (const check of checks.values()) {
			signal?.throwIfAborted();
			if (completed.has(check.id)) continue;
			const special = specials.get(check.id);
			const rule = commonRules.get(check.id);
			try {
				if (rule) {
					push(await runCommon(rule, check, options, vault, () => {
						readCommonEvidence ??= commonEvidence(linkOptions,located,found,manifest,template,templateDirs,new Set(commonRules.keys()));
						return readCommonEvidence(check,!!bundledCommonRule(rule));
					}));
					continue;
				}
				if (special) {
					push(await runSpecial(special, options, vault, context, found, identifiedVault, readLinks));
					continue;
				}
				switch (check.id) {
				case 'manifest': inspectManifest(check, options, manifest, template, found); break;
				case 'properties': inspectProperties(check, found, templateDirs); break;
				case 'bindings': checkBindings({result:check,...await bindingEvidence(linkOptions,located,manifest)},{tr}); break;
				case 'bases':
					reportInventoryCoverage(check,found);
					checkBases(await readBaseEvidence(linkOptions,located,found,check),{tr,addReason});
					break;
				case 'links': case 'anchors': case 'canvas': case 'portability': break;
			default: failure(check, 'checker-not-configured', template.reason ?? tr('本库未声明该项专项检查。','This library does not declare that template check.')); break;
				}
			} catch {
				signal?.throwIfAborted();
				failure(check, 'check-run-failed', tr('检查未能完成。','Could not complete the check.'));
			}
			push(check);
		}
		report.inputVersion = trace.finish(relative);
	} catch {
		if (signal?.aborted) return cancelled();
		const message = location ? tr('无法扫描知识库。','Could not scan the library.') : tr('无法访问指定的知识库根目录。','Could not access the selected library folder.');
		report.checks.push(failure(result(generalChecks[0]), 'library-unavailable', message));
	}
	report.status = aggregate(report.checks);
	report.finishedAt = new Date().toISOString();
	orderChecks();
	if (location) {
		try {await saveDiagnosticReport(location.root, location.vault, report, signal);}
		catch (error) {if (signal?.aborted) return cancelled(); throw error;}
	} else report.logError = tr('知识库根目录不可用，无法写入日志。','Could not save the log because the library folder is unavailable.');
	return report;

	function orderChecks() {
		report.checks.sort((a,b) => active.indexOf(a.id) - active.indexOf(b.id));
	}
	function cancelled() {
		report.status = 'cancelled';
		report.finishedAt = new Date().toISOString();
		if (all && !readTemplate) active.push(...listedTemplateChecks.map(check => check.id));
		for (const id of active) if (!report.checks.some(item => item.id === id)) report.checks.push({
			...result(describe(id)), status:'not-run', reason:tr('检查取消时此项尚未完成。','This check had not finished when the run was cancelled.'),
		});
		orderChecks();
		return report;
	}
}
