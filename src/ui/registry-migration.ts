import type { App } from 'obsidian';
import { tr } from '../i18n.ts';
import { registryPath } from '../registry/paths.ts';
import type { PluginDataRegistry } from '../registry/plugin-data.ts';
import { V3Dialog } from './dialog.ts';

export async function showRegistryMigration(app: App, registry: PluginDataRegistry, destination: string, refresh: () => Promise<void>,
	reviewIgnore?: (dialog: V3Dialog) => Promise<() => Promise<void>>) {
	const preview = await registry.previewMigration();
	if (!preview) return false;
	const dialog = new V3Dialog(app,tr('迁移知识库登记表','Migrate library registry'));
	dialog.facts([
		[tr('旧登记表','Legacy registry'),registryPath],
		[tr('目标文件','Destination'),destination],
		[tr('旧登记路径数','Paths in legacy registry'),String(preview.legacyPaths.length)],
		[tr('目标中已有路径数','Paths already in destination'),String(preview.currentPaths.length)],
	]);
	dialog.contentEl.createEl('p',{text:tr('确认后保留以下路径，并回读验证。验证成功后删除旧登记文件，旧目录为空时一并移除。','Confirm to save the following paths. After verifying the saved list, the plugin removes the legacy file and its folder if empty.')});
	dialog.lines(preview.paths);
	dialog.contentEl.createEl('p',{text:tr('库内 kb.toml 保持原样。如果多个配置目录共用旧登记文件，请先核对其他配置需要的路径。','Each library keeps its kb.toml. If several configuration folders share the legacy registry, check which paths the other configurations need first.')});
	dialog.contentEl.createEl('p',{text:tr('提交或同步插件 data.json 会包含知识库目录名。若要保密，请在提交前检查 Vault 根仓的 Git 忽略规则和已跟踪文件。','Committing or syncing plugin data.json includes your library folder names. For private paths, check the Vault repository’s ignore rules and tracked files before committing.')});
	const prepare = await reviewIgnore?.(dialog);
	dialog.action(tr('确认迁移','Confirm migration'),async () => {
		await registry.migrate(preview,prepare);
		dialog.close();
		await refresh();
	});
	dialog.action(tr('稍后处理','Later'),async () => { dialog.close(); });
	dialog.open();
	return true;
}
