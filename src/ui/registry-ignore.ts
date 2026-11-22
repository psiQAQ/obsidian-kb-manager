import type KnowledgeBaseManager from '../main.ts';
import { applyIgnoreRule, previewRegistryIgnore } from '../registry/desktop.ts';
import { tr } from '../i18n.ts';
import type { Dialog } from './dialog.ts';
import { changeComparison } from './change-preview.ts';

export function showAddedIgnoreRules(parent:HTMLElement,path:string,before:string|null|undefined,rules:string) {
	changeComparison(parent,[{
		label:path,before:before==null?tr('文件缺失','File missing'):tr('尚无所示规则','Rules absent'),after:rules,code:true,
	}]);
}

export async function reviewRegistryProtection(plugin:KnowledgeBaseManager, dialog:Pick<Dialog,'contentEl'>) {
	const rule=await previewRegistryIgnore(plugin.disk);
	if(rule.before!==rule.after)
		showAddedIgnoreRules(dialog.contentEl,plugin.t('仓库根目录 .gitignore','Vault root .gitignore'),rule.before,rule.rule);
	return ()=>applyIgnoreRule(plugin.disk,rule);
}
