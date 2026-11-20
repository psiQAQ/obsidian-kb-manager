export type Severity = 'error' | 'warning' | 'info';
export type DiagnosticStatus = 'passed' | 'findings' | 'partial' | 'skipped' | 'failed';

export interface Diagnostic {
	severity: Severity;
	code: string;
	message: string;
	file?: string;
	line?: number;
	evidence?: string;
}

export interface Coverage { checked: number; skipped: number; unknown: number }
export interface DiagnosticCheckResult {
	id: string;
	name: string;
	status: DiagnosticStatus;
	coverage: Coverage;
	diagnostics: Diagnostic[];
	reason?: string;
}

export interface TemplateIdentity { id: string; version: string }
export interface DiagnosticReport {
	schemaVersion: 1;
	runId: string;
	startedAt: string;
	finishedAt: string;
	environment: 'desktop' | 'offline';
	library: { id?: string; template?: TemplateIdentity };
	status: DiagnosticStatus;
	checks: DiagnosticCheckResult[];
	logPath?: string;
	logError?: string;
}

export interface LinkOccurrence {
	target: string;
	kind: 'link' | 'embed';
	line?: number;
	syntax?: 'wiki' | 'markdown';
}

export interface LinkRequest extends Omit<LinkOccurrence, 'line'> {
	source: string;
	fragment?: string;
	canvasPath?: boolean;
}

export interface LinkResolution {
	status: 'resolved' | 'missing' | 'unknown';
	path?: string;
	anchor?: 'resolved' | 'missing' | 'unknown';
	reason?: string;
}

export interface DiagnosticOptions {
	libraryRoot: string;
	vaultRoot?: string;
	configDir?: string;
	selected?: readonly string[] | 'all';
	registered?: boolean;
	duplicate?: boolean;
	registeredPaths?: readonly string[];
	resolveLink?: (request: LinkRequest) => LinkResolution | Promise<LinkResolution>;
	collectLinks?: (source: string) => LinkOccurrence[] | undefined | Promise<LinkOccurrence[] | undefined>;
	linkCandidates?: (request: LinkRequest) => readonly string[] | Promise<readonly string[]>;
	trustedDigests?: readonly string[];
	officialDigests?: readonly string[];
	nodeExecutable?: string;
	timeoutMs?: number;
}

export interface SpecialCheck { id: string; name: string; path: string; description?: string; digest?: string; reason?: string }
export interface CheckContext {
	template: Record<string, unknown>;
	manifest: Record<string, unknown>;
	libraryRoot: string;
	notes: { path: string; body: string; properties: Record<string, unknown> }[];
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

export function printable(value: unknown, max: number): value is string {
	return typeof value === 'string' && !!value.trim() && value.length <= max &&
		!Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export const generalChecks = [
	{id: 'manifest', get name() {return tr('清单与登记','Manifest and registration');}},
	{id: 'properties', get name() {return tr('属性语法','Property syntax');}},
	{id: 'links', get name() {return tr('链接与嵌入','Links and embeds');}},
	{id: 'anchors', get name() {return tr('标题和块引用','Headings and block references');}},
	{id: 'canvas', name: 'Canvas'}, {id: 'bases', name: 'Bases'},
	{id: 'bindings', get name() {return tr('受管绑定','Managed bindings');}},
] as const;

export const portabilityCheck = {id: 'portability', get name() {return tr('可移植性','Portability');}} as const;
export const generalIds: ReadonlySet<string> = new Set([...generalChecks, portabilityCheck].map(rule => rule.id));

export function result(rule: {id: string; name: string}): DiagnosticCheckResult {
	return {...rule, status: 'passed', coverage: {checked: 0, skipped: 0, unknown: 0}, diagnostics: []};
}

export function settle(check: DiagnosticCheckResult) {
	if (check.status === 'failed' || check.status === 'skipped') return check;
	check.status = check.coverage.unknown ? 'partial' : check.diagnostics.length ? 'findings' :
		check.coverage.checked ? 'passed' : 'skipped';
	if (check.status === 'skipped') check.reason ??= tr('没有适用的检查对象。','There was nothing to check for this rule.');
	return check;
}
import {tr} from '../i18n.ts';
