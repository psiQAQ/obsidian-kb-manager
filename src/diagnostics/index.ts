import {randomUUID} from 'node:crypto';
import {tr} from '../i18n.ts';
import {saveDiagnosticReport} from './history.ts';
import {inspectLinks} from './links.ts';
import {checkContext, inventory, libraryLocation, manifestSnapshot, templateSnapshot} from './snapshot.ts';
import {runSpecial} from './special.ts';
import {inspectBases, inspectBindings, inspectCanvas, inspectManifest, inspectProperties} from './structures.ts';
import {generalChecks, generalIds, portabilityCheck, result, settle} from './types.ts';
import type {DiagnosticCheckResult, DiagnosticOptions, DiagnosticReport, DiagnosticStatus, SpecialCheck, TemplateIdentity} from './types.ts';

export {generalChecks, portabilityCheck} from './types.ts';
export {baseViewStatus} from './base-view.ts';
export {listDiagnosticHistory} from './history.ts';
export type * from './types.ts';

export async function listSpecialChecks(libraryRoot: string): Promise<{template?: TemplateIdentity; checks: SpecialCheck[]; reason?: string}> {
	try {
		const {root} = await libraryLocation({libraryRoot});
		const list = await templateSnapshot(root, true);
		const template = list.template ? {id: list.template.id, version: list.template.version} : undefined;
		return {template, checks: list.checks.map(({id,name,path,description,digest,reason}) => ({id,name,path,description,digest,reason})),
			reason: list.reason ?? (list.missing ? tr('本库未配置模板专项检查。','This library has no template checks configured.') : undefined)};
	} catch {return {checks: [], reason: tr('无法访问知识库根目录。','Could not access the library folder.')};}
}

function aggregate(checks: DiagnosticCheckResult[]): DiagnosticStatus {
	if (checks.some(check => check.status === 'failed')) return 'failed';
	if (checks.some(check => check.status === 'partial' || check.diagnostics.some(row => row.code === 'checker-untrusted'))) return 'partial';
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

export async function runDiagnostics(options: DiagnosticOptions): Promise<DiagnosticReport> {
	const startedAt = new Date().toISOString();
	const report: DiagnosticReport = {schemaVersion:1, runId:randomUUID(), startedAt, finishedAt:startedAt,
		environment: options.resolveLink ? 'desktop' : 'offline', library:{}, status:'skipped', checks:[]};
	let location: Awaited<ReturnType<typeof libraryLocation>> | undefined;
	try {
		location = await libraryLocation(options);
		const {root, relative, vault, configDir, identifiedVault} = location;
		const selected = options.selected;
		const all = !selected || selected === 'all';
		const needsScripts = all || selected.some(id => !generalIds.has(id));
		const [manifest, template, found] = await Promise.all([manifestSnapshot(root), templateSnapshot(root, needsScripts), inventory(root, configDir)]);
		const identity = manifest.parsed?.identity;
		report.library = {id:identity?.id, template:template.template ? {id:template.template.id, version:template.template.version} : identity?.template};
		const dirs = new Set(template.template?.pageTemplates ?? []);
		if (manifest.parsed?.mapping?.templates) dirs.add(manifest.parsed.mapping.templates);
		const templateDirs = [...dirs];
		const specials = new Map(template.checks.map(check => [check.id,check]));
		const available = new Map([...generalChecks, portabilityCheck].map(rule => [rule.id as string,rule]));
		const active = all ? [...generalChecks.map(item => item.id), ...specials.keys()] : [...new Set(selected)];
		const checks = new Map(active.map(id => [id, result({id,name:available.get(id)?.name ?? specials.get(id)?.name ?? tr('专项检查','Template check')})]));
		const links = {links:checks.get('links'), anchors:checks.get('anchors'), portability:checks.get('portability')};
		if (Object.values(links).some(Boolean)) {
			try {await inspectLinks({...options,vaultRoot:identifiedVault ? vault : undefined}, found, root, relative, links);}
			catch {for (const check of Object.values(links)) if (check) failure(check, 'link-run-failed', tr('链接检查未能完成。','Could not complete the link check.'));}
		}
		const context = needsScripts && template.template && manifest.parsed ? checkContext(relative,template.template,manifest,found.notes) : undefined;
		for (const check of checks.values()) {
			const special = specials.get(check.id);
			try {
				if (special) {
					const omitted = found.unreadable.length + found.notes.filter(note => note.problem).length;
					report.checks.push(await runSpecial(special, options, vault, context, omitted, identifiedVault));
					continue;
				}
				switch (check.id) {
				case 'manifest': inspectManifest(check, options, manifest, template, found); break;
				case 'properties': inspectProperties(check, found, templateDirs); break;
				case 'bindings': await inspectBindings(check, manifest, root, identifiedVault ? relative : undefined); break;
				case 'canvas': await inspectCanvas(check, root, found, options, relative); break;
				case 'bases': await inspectBases(check, root, found, templateDirs); break;
				case 'links': case 'anchors': case 'portability': break;
			default: failure(check, 'checker-not-configured', template.reason ?? tr('本库未声明该项专项检查。','This library does not declare that template check.')); break;
				}
			} catch {failure(check, 'check-run-failed', tr('检查未能完成。','Could not complete the check.'));}
			report.checks.push(settle(check));
		}
	} catch {
		const message = location ? tr('无法扫描知识库。','Could not scan the library.') : tr('无法访问指定的知识库根目录。','Could not access the selected library folder.');
		report.checks.push(failure(result(generalChecks[0]), 'library-unavailable', message));
	}
	report.status = aggregate(report.checks);
	report.finishedAt = new Date().toISOString();
	if (location) await saveDiagnosticReport(location.root, location.vault, report);
	else report.logError = tr('知识库根目录不可用，无法写入日志。','Could not save the log because the library folder is unavailable.');
	return report;
}
