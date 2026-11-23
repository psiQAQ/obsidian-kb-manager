import {tr} from '../i18n.ts';
import {builtinCheckDeclarations} from '../kb/common-rules.ts';
import type {InputTrace} from './provenance.ts';
import {readChecker} from './snapshot.ts';
import type {TemplateSnapshot} from './snapshot.ts';
import type {DiagnosticOptions, SpecialCheck, TemplateIdentity} from './types.ts';

type ExpectedCheck = Pick<SpecialCheck,'id'|'name'>;

async function expectedChecks(root: string, identity: TemplateIdentity | undefined,
	known: readonly ExpectedCheck[], signal?: AbortSignal, trace?: InputTrace) {
	if (known.length) return {confirmed:true, checks:known};
	const catalog = builtinCheckDeclarations();
	const pack = catalog.find(item => item.id === identity?.id);
	if (pack && pack.version === identity?.version) return {confirmed:true, checks:pack.checks};

	// Historic official scripts can establish that declarations existed without guessing
	// from a filename or assuming every earlier release of the template had checks.
	const candidates = pack ? [pack] : !identity || identity.id === 'unknown' ? catalog : [];
	const scripts = new Map<string,string>();
	for (const path of new Set(candidates.flatMap(item => item.checks.map(check => check.path)))) {
		try {
			scripts.set(path,(await readChecker(root,path,signal,trace)).digest);
		} catch {signal?.throwIfAborted();}
	}
	const checks = candidates.flatMap(item => item.checks.filter(check => {
		const digest = scripts.get(check.path);
		return digest && check.digests.includes(digest);
	}));
	return {confirmed:checks.length > 0, checks};
}

export async function templateDeclarationIssue(root: string, state: TemplateSnapshot['state'], identity?: TemplateIdentity,
	known: DiagnosticOptions['knownTemplateChecks'] = [], signal?: AbortSignal, trace?: InputTrace) {
	if (!state) return;
	const {confirmed, checks} = await expectedChecks(root,identity,known,signal,trace);
	if (state === 'missing' && !confirmed) return;
	// Use IDs only; check titles come from the listing or catalog and are not needed in diagnostics.
	const unique = [...new Map(checks.map(check => [check.id,check])).values()];
	const message = state === 'missing'
		? tr('缺少 kb-template.json，无法运行预期的专项检查。','kb-template.json is missing, so the expected template checks cannot run.')
		: state === 'unreadable'
			? tr('无法读取 kb-template.json，无法确定或运行模板专项检查。','Could not read kb-template.json to identify or run template checks.')
			: tr('kb-template.json 无效，无法确定或运行模板专项检查。','kb-template.json is invalid, so template checks could not be identified or run.');
	return {
		checks:unique,
		code: state === 'missing' ? 'missing-template-declaration' : state === 'unreadable' ? 'unreadable-template-declaration' : 'invalid-template',
		message,
		scope:tr('无法确认模板声明中的诊断排除范围。','Could not verify which sources the template declaration excludes.'),
	};
}
