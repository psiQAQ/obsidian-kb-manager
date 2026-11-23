import {tr} from '../i18n.ts';
import type {Coverage, Diagnostic, LinkRequest} from './types.ts';

const instanceToken = /\{\{(?:kb_name|description|kb_root|base_path)\}\}|__(?:KB_ROOT|WIKI_PATH|NOTES_PATH|WIKI_DIR|TEMPLATES_DIR|CATEGORY_PATH)__/u;
export const knownInstancePlaceholder = (value: string) => instanceToken.exec(value)?.[0];
export const dynamicTarget = (value: string) => /\{\{|<%/u.test(value) || instanceToken.test(value);
export const isTemplateSource = (file: string, templateDirs: readonly string[]) => templateDirs.some(dir => file.startsWith(dir + '/'));

export interface LinkPlaceholder {
	coverage: keyof Coverage;
	diagnostic: Pick<Diagnostic,'severity'|'code'|'message'|'evidence'>;
}

export function linkPlaceholder(link: LinkRequest, inTemplate: boolean, canvas = false): LinkPlaceholder | undefined {
	const value = link.target + '\n' + (link.fragment ?? '');
	if (!dynamicTarget(value)) return;
	if (inTemplate) return {coverage:'skipped',diagnostic:{severity:'info',code:'template-link-deferred',message:canvas
		? tr('Canvas 中的模板链接待实例化后检查。','Check the Canvas template link after its variables are filled in.')
		: tr('模板链接待填入变量后检查。','Check this template link after its variables are filled in.')}};
	const evidence = knownInstancePlaceholder(value);
	if (evidence) return {coverage:'checked',diagnostic:{severity:'error',code:'link-placeholder-unfilled',evidence,
		message:tr('链接路径中的实例占位符尚未填写。','The link still contains an unfilled instance placeholder.')}};
	return {coverage:'unknown',diagnostic:{severity:'info',code:'runtime-link-unverified',
		message:tr('链接使用运行时变量，需在相应模板或自动化上下文中确认。','Verify the link in the template or automation that supplies its runtime variables.')}};
}
