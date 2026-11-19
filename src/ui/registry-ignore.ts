import type KnowledgeBaseManager from '../main.ts';
import { applyIgnoreRule, previewRegistryIgnore } from '../registry/desktop.ts';
import type { Dialog } from './dialog.ts';

export async function reviewRegistryProtection(plugin:KnowledgeBaseManager, dialog:Dialog) {
	const rule=await previewRegistryIgnore(plugin.disk);
	if(rule.before!==rule.after)
		dialog.lines([plugin.t('Vault 根目录 .gitignore 新增规则','Add to Vault root .gitignore')+' · '+rule.rule]);
	return ()=>applyIgnoreRule(plugin.disk,rule);
}
