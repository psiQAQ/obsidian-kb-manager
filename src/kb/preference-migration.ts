import { tr } from '../i18n.ts';
import type { GitPreferences } from '../preferences.ts';
import type { Library } from './catalog.ts';

export function previewPreferenceMigration(libraries:Library[], id:string, previous:Partial<GitPreferences>|undefined) {
	if(!previous)throw new Error(tr('待迁移设置已变化，请刷新','Pending preferences changed. Refresh and preview again'));
	const matches=libraries.filter(lib=>lib.identity?.id===id);
	const target=matches[0];
	if(matches.length!==1 || !target?.signature || target.missing || target.duplicate || target.problem || target.identity?.archived)
		throw new Error(tr('请先登记唯一且可写的同 ID 知识库','Register a unique, writable library with the same ID first'));
	return {target,previous:{...previous},overrides:{...target.preferences,...previous}};
}
