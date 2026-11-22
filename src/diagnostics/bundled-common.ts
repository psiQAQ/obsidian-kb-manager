import anchors from '../../assets/checks/common/anchors.mjs';
import bases from '../../assets/checks/common/bases.mjs';
import bindings from '../../assets/checks/common/bindings.mjs';
import canvas from '../../assets/checks/common/canvas.mjs';
import links from '../../assets/checks/common/links.mjs';
import manifest from '../../assets/checks/common/manifest.mjs';
import portability from '../../assets/checks/common/portability.mjs';
import properties from '../../assets/checks/common/properties.mjs';
import {commonRuleDigests} from '../kb/common-rules.ts';
import {tr} from '../i18n.ts';
import {addReason} from './coverage.ts';
import {printable} from './types.ts';
import type {SpecialCheck} from './types.ts';

const rules = new Map<string, (evidence: never, tools: typeof helpers) => unknown>([
	['checks/common/anchors.mjs',anchors],
	['checks/common/bases.mjs',bases],
	['checks/common/bindings.mjs',bindings],
	['checks/common/canvas.mjs',canvas],
	['checks/common/links.mjs',links],
	['checks/common/manifest.mjs',manifest],
	['checks/common/portability.mjs',portability],
	['checks/common/properties.mjs',properties],
]);

const helpers = {tr, addReason, validText:printable};

const previousBundledDigests = new Map([
	['checks/common/bindings.mjs','6790d389efcf4140efe309cfa4a36ffffbe56dc210886ce44019b012c796bd49'],
	['checks/common/bases.mjs','9a301508ebad2ce27efee92063786709b1a7f30a0d9165cdd6da0ae088e53104'],
]);

export function bundledCommonDigest(check: SpecialCheck) {
	const current = commonRuleDigests()[check.path];
	if (check.digest && (current === check.digest || previousBundledDigests.get(check.path) === check.digest))
		return current;
	return undefined;
}

export function bundledCommonRule(check: SpecialCheck) {
	if (bundledCommonDigest(check)) return rules.get(check.path);
	return undefined;
}

export async function runBundledCommon(rule: NonNullable<ReturnType<typeof bundledCommonRule>>, readContext: () => Promise<unknown>,
	signal?: AbortSignal): Promise<{data:unknown} | {error:string}> {
	const context = await readContext();
	signal?.throwIfAborted();
	try {
		// Each imported rule consumes the evidence prepared for its own check ID.
		return {data:rule(context as never,helpers)};
	} catch {return {error:'checker-execution'};}
}
