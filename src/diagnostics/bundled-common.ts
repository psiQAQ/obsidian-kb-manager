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
import {recordChecked} from './checked-items.ts';
import {recordLinkPlaceholder} from './common-tools.ts';
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

const helpers = {tr, addReason, validText:printable, recordChecked, recordLinkPlaceholder};

const previousBundledDigests = new Map([
	['checks/common/anchors.mjs',['0c9a5753ecf988f5c9209eda8f350ac58eb07aa68968986cc16a2c3a244374e3', '051282aa5ff0db4f027f1edb1a898b54caae6fa1c3593fe7495eb66de0b9b50c']],
	['checks/common/bases.mjs',[
		'bba90c5702efcd5c4fab4c99d62eebb1d7080c1b16faf5cb5affc9467b961a69',
		'9a301508ebad2ce27efee92063786709b1a7f30a0d9165cdd6da0ae088e53104',
		'66045471f46dcaef2782b6d73ba7632120618552b65abf735737327639392290',
		'1dd512af43ebfb549ea3d01d605e1a5d871699409ab063ac980a1f6bd5f4d933',
		'1f665454154cb353561302183c0efdb9659d8cefa2e9f73ba1d1896189c73a3b',
	]],
	['checks/common/bindings.mjs',['6790d389efcf4140efe309cfa4a36ffffbe56dc210886ce44019b012c796bd49', '7600c8340602186f9434de740be2812218e20bc3b633e80f14f6876281460169']],
	['checks/common/canvas.mjs',['211e4cacfae13a667f37ffeb69732f0922404af316e4b3d553fc2eb8dbc335cb', 'c37564faf4034ca457f39ef4e3f39b48af4bb5555bae0433d8f8389f04e25559']],
	['checks/common/links.mjs',['9d6f8140618cea057357fd657c195b120ef59951be6188c1c24b71e8e815f1e3', '5eeade553b2ee495a5fb1594d577d60fb725acb4d936c06a179937dc9f05ab2b']],
	['checks/common/manifest.mjs',['3593541067b163c7562d29b1f36ec1af75a7de537e035a814321224a6bf7ac7e']],
	['checks/common/portability.mjs',['86a03894093c781236388962a9127568b192e81a6ab37163936b9d96424ce7e7', '2f23453b25c6048dc688dd47c22fb1822a12a4ab4175d04d9602d05c4bbee8ce']],
	['checks/common/properties.mjs',['ecd63c1bcbe0af5f3fe74779a66eba2d5cb06f6a7d6ef71d641aa3d613e4705b']],
]);

export function bundledCommonDigest(check: SpecialCheck) {
	const current = commonRuleDigests()[check.path];
	if (check.digest && (current === check.digest || previousBundledDigests.get(check.path)?.includes(check.digest)))
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
