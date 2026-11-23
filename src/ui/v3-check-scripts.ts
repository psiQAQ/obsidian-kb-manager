import {createTwoFilesPatch} from 'diff';
import {readDiagnosticScript} from '../diagnostics/common.ts';
import type {SpecialCheck} from '../diagnostics/types.ts';
import {digest} from '../fs/vault.ts';
import {tr} from '../i18n.ts';
import {applyCheckKitUpdate, previewCheckKitUpdate} from '../kb/check-kit-update.ts';
import type KnowledgeBaseManager from '../main.ts';
import {V3Dialog} from './dialog.ts';
import {changeActions, changeComparison} from './change-preview.ts';

function trustKey(plugin: KnowledgeBaseManager) {
	return plugin.manifest.id+':check-script-trust';
}

export function trustedDigests(plugin: KnowledgeBaseManager): string[] {
	const value: unknown = plugin.app.loadLocalStorage(trustKey(plugin));
	return Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item)) : [];
}

function showSource(parent: HTMLElement, label: string, source: string) {
	const panel = parent.createEl('details',{cls:'kb-v3-detail'});
	panel.createEl('summary',{text:label});
	panel.createEl('pre',{cls:'kb-v3-code'}).createEl('code',{text:source});
}

function showDifference(parent: HTMLElement, before: string, after: string, left: string, right: string) {
	const patch = createTwoFilesPatch(left,right,before,after,undefined,undefined,{timeout:250});
	if (patch !== undefined) parent.createEl('pre',{cls:'kb-v3-code'}).createEl('code',{text:patch});
	else {
		parent.createEl('p',{cls:'kb-v3-muted',text:tr('文本差异计算超时。可分别查看两份文件。','The text comparison timed out. You can view each file below.')});
		showSource(parent,left,before);
		showSource(parent,right,after);
	}
}

export async function reviewDiagnosticScript(plugin: KnowledgeBaseManager, location: string, check: SpecialCheck,
	official: string | undefined, refresh: () => Promise<void>) {
	const read = async () => readDiagnosticScript(await plugin.disk.path(location),check.path);
	const reviewed = await read();
	const changed = () => new Error(tr('脚本已变更，请重新检查。','The script changed. Review it again.'));
	if (reviewed.digest !== check.digest) throw changed();
	const dialog = new V3Dialog(plugin.app,tr('审查检验脚本','Review check script'));
	const facts: [string,string][] = [[tr('脚本','Script'),location+'/'+check.path],['SHA-256',reviewed.digest]];
	if (official !== undefined) facts.push([tr('官方文件 SHA-256','Official file SHA-256'),digest(official)]);
	dialog.facts(facts);
	dialog.contentEl.createEl('p',{text:tr(
		'授权仅适用于上方摘要对应的脚本。脚本以本机账号权限运行，可以读写文件和访问网络。',
		'Approval applies only to the digest above. The script runs with your account permissions and can read and write files and access the network.',
	)});
	if (official !== undefined) {
		showDifference(dialog.contentEl,official,reviewed.source,tr('官方文件','Official file'),tr('本地脚本','Local script'));
		showSource(dialog.contentEl,tr('查看完整脚本','View full script'),reviewed.source);
	} else dialog.contentEl.createEl('pre',{cls:'kb-v3-code'}).createEl('code',{text:reviewed.source});
	if (!trustedDigests(plugin).includes(reviewed.digest)) {
		changeActions(dialog.contentEl,[{label:tr('授权此脚本版本','Approve this script version'),primary:true,run:async()=>{
			if ((await read()).digest !== reviewed.digest) throw changed();
			plugin.app.saveLocalStorage(trustKey(plugin),[...new Set([...trustedDigests(plugin),reviewed.digest])]);
			await refresh();
			dialog.close();
		}}]);
	}
	dialog.open();
}

const updateLabels = {
	current:['最新','Up to date'],replace:['可更新','Ready to update'],add:['可添加','Ready to add'],
	modified:['已修改，需人工合并','Edited · merge manually'],missing:['已缺失，保留现状','Missing · left as is'],
	unavailable:['无法读取，需人工检查','Unavailable · review manually'],
	blocked:['等待复核配套文件','Companion file needs review'],
} as const;

export async function showCheckKitUpdate(plugin: KnowledgeBaseManager, location: string, refresh: () => Promise<void>) {
	const plan = await previewCheckKitUpdate(plugin.disk,location);
	if (!plan) throw new Error(tr('此知识库没有已安装的检验工具包。','This library has no installed check kit.'));
	const dialog = new V3Dialog(plugin.app,tr('预览检验工具更新','Preview check kit update'));
	dialog.facts([[tr('知识库','Library'),location]]);
	changeComparison(dialog.contentEl,[{label:tr('检验工具版本','Check kit version'),before:plan.installedVersion,
		after:plan.targetVersion,afterLabel:plan.canApply?undefined:tr('插件提供版本','Bundled version')}]);
	const files = [...plan.files,...plan.courseworkFiles,...plan.templateFiles];
	if (plan.downgrade) dialog.contentEl.createEl('p',{text:tr('此知识库已安装更新的检验工具包。','This library has a newer check kit installed.')});
	else if (files.some(file => file.change === 'modified' || file.change === 'missing' || file.change === 'unavailable'))
		dialog.contentEl.createEl('p',{text:tr('已修改、缺失或无法读取的文件需要人工处理。','Review edited, missing, or unavailable files manually.')});
	for (const file of files) {
		if (file === plan.courseworkFiles[0]) dialog.contentEl.createEl('h3',{text:tr('课程与截止日检查','Course and due date check')});
		if (file === plan.templateFiles[0]) dialog.contentEl.createEl('h3',{text:tr('模板专项检查','Template checks')});
		const entry = dialog.contentEl.createEl('details',{cls:'kb-v3-detail'});
		const heading = entry.createEl('summary');
		heading.createSpan({text:file.path});
		const [zh,en] = updateLabels[file.change];
		heading.createSpan({cls:'kb-v3-muted',text:' · ' + tr(zh,en)});
		if (file.reason) entry.createEl('p',{text:file.reason});
		const fingerprints: [string,string][] = [];
		if (file.installedDigest) fingerprints.push([tr('本地 SHA-256','Local SHA-256'),file.installedDigest]);
		if (file.targetDigest) fingerprints.push([tr('更新后 SHA-256','Updated SHA-256'),file.targetDigest]);
		const facts = entry.createEl('dl',{cls:'kb-preview-facts'});
		for (const [label,value] of fingerprints) {
			facts.createEl('dt',{text:label});
			facts.createEl('dd',{text:value});
		}
		const after = file.after;
		if (file.change === 'current' || after === undefined) continue;
		const reviewContents=()=>{
			if (!entry.open) return;
			entry.removeEventListener('toggle',reviewContents);
			const applies=plan.canApply && (file.change==='add' || file.change==='replace');
			const before=file.before ?? (file.change==='unavailable'?tr('无法读取文件','File unavailable'):
				file.installedDigest?tr('无法显示为 UTF-8 文本','Unavailable as UTF-8 text'):tr('文件缺失','File missing'));
			changeComparison(entry,[{label:tr('文件内容','File content'),before,after,code:true,
				afterLabel:applies?undefined:tr('候选内容','Proposed content')}]);
		};
		entry.addEventListener('toggle',reviewContents);
	}
	if (plan.canApply) {
		changeActions(dialog.contentEl,[{label:tr('更新符合条件的文件','Update eligible files'),primary:true,run:async()=>{
			await plugin.exclusive(location,()=>applyCheckKitUpdate(plugin.disk,location,plan));
			await refresh();
			dialog.close();
		}}]);
	}
	dialog.open();
}
