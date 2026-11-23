import {tr} from '../i18n.ts';
import type {CheckDeclaration} from './template-declaration.ts';

export const readmePath='README.md';

function commonInstructions(translate:typeof tr) {
	return [
		translate('检验本库','Check this library'),
		'',
		translate('在本库根目录使用 Node.js 20 或更新版本运行：','From the library root, run the following command with Node.js 20 or later.'),
		'',
		'```sh',
		'node ./checks/kb-check.cjs --library . --checks all',
		'```',
		'',
		translate('命令输出 JSON，报告保存在本库的 `.log/` 目录。使用 `--list` 查看通用和模板专项检验，使用 `--checks <id>` 指定检验。',
			'The command prints JSON and saves the report in the library’s `.log/` folder. Use `--list` to see the general and template checks, or `--checks <id>` to run a specific check.'),
		'',
		translate('逐项查看 `checks[].status`、`coverage` 和 `diagnostics`。在 Obsidian 外运行时，部分链接可能因缺少 Vault 上下文而无法判定。例如，`status: partial`、`coverage.checked: 17`、`coverage.unknown: 3` 表示已检查 17 项，还有 3 项待核对。需要 Vault 范围的解析时，可以提供 `--vault-root <path>`。',
			'Review `checks[].status`, `coverage`, and `diagnostics` for each check. Outside Obsidian, some links may be unresolved without vault context. For example, `status: partial`, `coverage.checked: 17`, and `coverage.unknown: 3` mean 17 items were checked and 3 need review. Pass `--vault-root <path>` for vault-wide resolution.'),
		'',
	];
}

function specialIntro(translate:typeof tr) {
	return translate('本模板在 `kb-template.json` 中声明了以下专项检验。脚本位于 `checks/`，运行需通过脚本信任检查。',
		'This template declares the following checks in `kb-template.json`. The scripts are in `checks/` and must pass script trust checks before they run.');
}

function noSpecialChecks(translate:typeof tr) {
	return translate('本模板未声明专项检验。','This template declares no template checks.');
}

export function checkInstructions(checks:readonly CheckDeclaration[]|undefined) {
	const markdownText=(value:string)=>value.trim().replace(/\s+/gu,' ').replace(/[\\`*_[\]<>]/gu,'\\$&');
	return [
		...commonInstructions(tr),
		...(checks?.length?[
			specialIntro(tr),
			'',
			...checks.map(({id,name,description})=>'- `'+id+'` · '+markdownText(name)+(description?.trim()?tr('（',' (')+markdownText(description)+tr('）',')'):'')),
		]:checks?[noSpecialChecks(tr)]:[]),
		'',
	];
}

// Directory-template updates leave the installed check declaration and scripts in place.
// Reuse the existing guide in either language, including those original check descriptions.
export function installedCheckInstructions(original:string|undefined) {
	if(original===undefined)return;
	const text=original.replace(/\r\n/gu,'\n');
	for(const translate of [(zh:string)=>zh,(_zh:string,en:string)=>en]){
		const prefix='## '+commonInstructions(translate).join('\n')+'\n';
		const start=text.lastIndexOf(prefix);
		if(start<0 || (start>0 && text.slice(0,start)!=='\uFEFF' && text.slice(start-2,start)!=='\n\n'))continue;
		const details=text.slice(start+prefix.length), introduction=specialIntro(translate)+'\n\n';
		if(details && details!==noSpecialChecks(translate)+'\n' &&
			!(details.startsWith(introduction) && /^(?:- `[a-zA-Z0-9][a-zA-Z0-9._-]*` · [^\n]+\n)+$/u.test(details.slice(introduction.length))))continue;
		return text.slice(start+3).split('\n');
	}
	return undefined;
}

export function composeCheckReadme(original:string|undefined,instructions:readonly string[]) {
	const newline=original?.includes('\r\n')?'\r\n':'\n';
	const section=(original===undefined?'#':'##')+' '+instructions.join(newline);
	if(original?.endsWith(section))return original;
	const separator=!original || original==='\uFEFF' || original.endsWith(newline.repeat(2))?'':original.endsWith(newline)?newline:newline.repeat(2);
	return (original??'')+separator+section;
}
