import type {App} from 'obsidian';
import {tr} from '../i18n.ts';

export interface PluginRequirement {id: string; required: boolean; minVersion?: string}
export type TemplateDependency = string | PluginRequirement;
export interface TemplateRequirements {minManagerVersion?: string; dependencies?: TemplateDependency[]}
export interface TemplateHost {version: string; pluginVersion(id: string): string | undefined}

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export const validMinimum = (value: unknown): value is string => typeof value === 'string' && stable.test(value);

// Minimums are stable x.y.z releases. A prerelease of that same version is older.
function atLeast(installed: string, minimum: string) {
	const version = installed.split('+', 1)[0]!;
	const core = version.split('-', 1)[0]!;
	if (!validMinimum(core)) return false;
	const expected = minimum.split('.');
	for (const [index, part] of core.split('.').entries()) {
		const other = expected[index]!;
		if (part.length !== other.length) return part.length > other.length;
		if (part !== other) return part > other;
	}
	return core === version;
}

export function templateHost(app: App, version: string): TemplateHost {
	// The desktop and mobile hosts expose loaded community plugins through
	// getPlugin. A disabled or unavailable plugin cannot supply a workflow.
	const plugins = (app as App & {plugins?: {getPlugin?(id:string): {manifest:{version:string}} | null}}).plugins;
	return {version, pluginVersion: id => plugins?.getPlugin?.(id)?.manifest.version};
}

export function templateCompatibility(spec: TemplateRequirements, host: TemplateHost) {
	const blockers: string[] = [], optional: string[] = [];
	if (spec.minManagerVersion && !atLeast(host.version, spec.minManagerVersion)) {
		blockers.push(tr('请将知识库管理器升级到 ', 'Update Knowledge Base Manager to ') + spec.minManagerVersion +
			tr(' 或更高版本。当前版本为 ', ' or later. Current version: ') + host.version);
	}
	for (const entry of spec.dependencies ?? []) {
		const {id, required, minVersion} = typeof entry === 'string' ? {id:entry, required:false, minVersion:undefined} : entry;
		const installed = host.pluginVersion(id);
		if (installed && (!minVersion || atLeast(installed,minVersion))) continue;
		const action = installed ? tr('升级 ', 'Update ') : tr('启用 ', 'Enable ');
		const version = minVersion ? ' ≥ ' + minVersion : '';
		(required ? blockers : optional).push(action + id + version);
	}
	return {blockers, optional};
}
