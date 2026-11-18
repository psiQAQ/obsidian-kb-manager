import { Modal, Notice, PluginSettingTab, Setting, moment } from 'obsidian';
import { hostname } from 'node:os';
import type KnowledgeBaseManager from './main.ts';
import { validateFolders } from './fs/vault.ts';
import { recheck } from './kb/catalog.ts';
import type { Library } from './kb/catalog.ts';
import type { GitPreferences, Language } from './preferences.ts';
import { gitDefaults, renderCommitMessage } from './preferences.ts';
import { diagnostics, gitDisabled, setDeviceGitDisabled } from './ui/device.ts';

const categories = {
	folders: ['知识库目录与模板', 'Library folders and templates'],
	automatic: ['自动化', 'Automatic'],
	commit: ['提交', 'Commit'],
	sync: ['同步', 'Sync'],
	editor: ['编辑器', 'Editor'],
	views: ['视图', 'Views'],
	interface: ['界面', 'Interface'],
	identity: ['身份与凭据', 'Identity and credentials'],
	advanced: ['高级', 'Advanced'],
} as const;
type Category = keyof typeof categories;
type Label = readonly [string,string];
type BooleanKey = { [K in keyof GitPreferences]: GitPreferences[K] extends boolean ? K : never }[keyof GitPreferences];
type ChoiceKey = { [K in keyof GitPreferences]: GitPreferences[K] extends string ? string extends GitPreferences[K] ? never : K : never }[keyof GitPreferences];

class SettingsPages {
	private page?: Category;
	constructor(private plugin: KnowledgeBaseManager, private el: HTMLElement, private lib?: Library) {}

	render() {
		const {el,plugin,lib,page} = this;
		const t = (zh: string,en: string) => plugin.t(zh,en);
		el.empty();
		if (!page) {
			if (!lib) {
				new Setting(el).setName(t('界面语言','Language')).addDropdown(input => input
					.addOptions({system:t('跟随 Obsidian','Follow Obsidian'), zh:'简体中文', en:'English'})
					.setValue(plugin.prefs.language).onChange(async value => {
						plugin.prefs.language = value as Language;
						try { await plugin.persist(); await plugin.refresh(); this.render(); }
						catch (error) { new Notice(String(error)); }
					}));
			}
			for (const key of Object.keys(categories) as Category[]) {
				if (lib && key === 'folders') continue;
				const name = t(categories[key][0],categories[key][1]);
				new Setting(el).setName(name).addButton(button => button.setButtonText(t('打开','Open'))
					.setTooltip(name).onClick(() => { this.page = key; this.render(); }));
			}
			return;
		}
		new Setting(el).setName(t(categories[page][0],categories[page][1])).setHeading()
			.addButton(button => button.setButtonText(t('返回分类','Back to categories')).onClick(() => {
				this.page = undefined; this.render();
			}));
		if (page === 'folders') {
			this.folders(); return;
		}

		const id = lib?.identity?.id;
		const source = () => (id ? plugin.prefs.libraries[id] : plugin.prefs.defaults) ?? {};
		const draft = {...source()};
		const touched = new Set<keyof GitPreferences>();
		const inherited = plugin.preferences();
		const current = plugin.preferences(id);
		const inputs = el.createDiv();
		const draw = () => {
			inputs.empty();
			const row = (key: keyof GitPreferences, label: Label, description?: Label) => {
				const inheritedLabel = draft[key] === undefined ? t('继承全局设置','Inherited') : t('本库覆盖','Library override');
				const setting = new Setting(inputs).setName(t(...label));
				const desc = [id ? inheritedLabel : '', description ? t(...description) : ''].filter(Boolean).join(' · ');
				if (desc) setting.setDesc(desc);
				if (id && key in draft) setting.addExtraButton(button => button.setIcon('reset')
					.setTooltip(t('恢复继承','Use global default')).onClick(() => {
						delete draft[key]; touched.add(key); draw();
					}));
				return setting;
			};
			const value = <K extends keyof GitPreferences>(key: K) =>
				draft[key] ?? (id ? inherited[key] : current[key]);
			const set = <K extends keyof GitPreferences>(key: K, next: GitPreferences[K]) => {
				draft[key] = next; touched.add(key);
			};
			const text = (key: 'author'|'email'|'commitMessage'|'autoCommitMessage'|'commitDateFormat'|'commitHostname'|'blameFormat'|'blameText', label: Label, desc?: Label) =>
				row(key,label,desc).addText(input => input.setValue(value(key)).onChange(s => set(key,s)));
			const toggle = (key: BooleanKey, label: Label, desc?: Label) =>
				row(key,label,desc).addToggle(input => input.setValue(value(key)).onChange(b => set(key,b)));
			const choice = <K extends ChoiceKey>(key: K, label: Label, options: Record<GitPreferences[K],string>, desc?: Label) =>
				row(key,label,desc).addDropdown(input => input.addOptions(options).setValue(value(key))
					.onChange(s => set(key,s as GitPreferences[K])));
			const note = (zh: string,en: string) => inputs.createEl('p',{text:t(zh,en)});
			switch (page) {
				case 'automatic':
					note('0 表示关闭。在本库的 Git 状态面板确认范围后，才会开始自动操作。','Zero disables a timer. Authorize the scope in the library’s Git status panel to start automation.');
					text('autoCommitMessage',['自动提交说明模板','Auto commit message template'],
						['支持与手动提交相同的占位符。','Accepts the same placeholders as a manual commit.']);
					toggle('autoAfterEdits',['等停止编辑后提交','Wait for editing to stop before committing']);
					toggle('autoFromLastCommit',['从最后一次提交开始计时','Start the timer from the latest commit']);
					toggle('autoPullOnStart',['启动时拉取','Pull on startup']);
					choice('autoGlobMode',['自动提交文件匹配方式','Auto commit glob mode'],{include:t('仅包含匹配项','Include matching paths'),exclude:t('排除匹配项','Exclude matching paths')});
					row('autoGlobs',['自动提交文件匹配规则','Auto commit globs'],['每行一个相对于本库的 glob 表达式。','Enter one library-relative glob per line.'])
						.addTextArea(input => input.setValue(value('autoGlobs')).onChange(s => set('autoGlobs',s)));
					for (const [key,label] of [
						['autoCommitMinutes',['自动提交间隔（分钟）','Auto commit interval (minutes)']],
						['autoPullMinutes',['自动拉取间隔（分钟）','Auto pull interval (minutes)']],
						['autoPushMinutes',['自动推送间隔（分钟）','Auto push interval (minutes)']],
					] as const) row(key,label).addText(input => {
						input.inputEl.type = 'number'; input.inputEl.min = '0'; input.inputEl.step = '1';
						input.setValue(String(value(key))).onChange(s => set(key,s.trim() ? Number(s) : NaN));
					});
					break;
				case 'commit':
					toggle('autoStageOnEmptyIndex',['索引为空时暂存并提交全部改动','Stage all changes when nothing is staged']);
					toggle('listChangedFilesInMessageBody',['在提交正文列出变更文件','List changed files in the commit body']);
					text('commitMessage',['手动提交说明模板','Manual commit message template'],
						['支持 {{date}}、{{hostname}}、{{files}} 和 {{numFiles}}，提交前可以编辑。','Use {{date}}, {{hostname}}, {{files}} and {{numFiles}}. You can edit the result before committing.']);
					text('commitDateFormat',['日期格式','Date format']);
					text('commitHostname',['主机名替换文本','Hostname replacement'],['留空使用本机名称。','Leave empty to use this device’s hostname.']);
					new Setting(inputs).setName(t('预览提交说明','Preview commit message'))
						.addButton(button => button.setButtonText(t('预览','Preview')).onClick(() => {
							const example = renderCommitMessage({commitMessage:value('commitMessage'),commitHostname:value('commitHostname')},
								moment().format(value('commitDateFormat')),hostname(),['Notes/example.md']);
							new Notice(example || t('提交时手动填写说明','Enter a message when committing'));
						}));
					break;
				case 'sync':
					toggle('squashCommitsBeforePush',['推送前合并未推送的提交','Squash unpushed commits before pushing'],['提交并同步时，复核上游之后的本地线性提交。','Review the local commits after the upstream tip when committing and syncing.']);
					toggle('pullBeforePush',['提交并同步时拉取','Pull on commit and sync']);
					toggle('disablePush',['提交并同步时跳过推送','Skip push on commit and sync']);
					choice('syncMethod',['拉取策略','Pull strategy'],{
						'ff-only':t('仅快进','Fast-forward only'),merge:t('合并','Merge'),rebase:t('变基','Rebase'),
					},['合并和变基需要原生后端。远端与上游分支在本库的 Git 状态面板配置。','Merge and rebase require native Git. Configure the remote and upstream in the library’s Git status panel.']);
					choice('mergeStrategy',['合并冲突时的偏好','Merge conflict strategy'],{none:t('Git 默认','Git default'),ours:t('倾向本地一方','Favor our changes'),theirs:t('倾向远端一方','Favor their changes')},
						['用于原生后端的手动合并。变基要求干净工作区，已有暂存和修改请先自行处理。','Used for manual merges with native Git. Rebase requires a clean worktree and index.']);
					break;
				case 'editor':
					choice('conflictResolutionMode',['显示冲突块操作','Show conflict resolution controls'],{source:t('源码模式','Source mode'),'live-preview':t('实时预览模式','Live preview'),both:t('两种编辑模式','Both editing modes'),disabled:t('关闭','Disabled')});
					toggle('hunkSigns',['在编辑器行旁标记改动','Show change markers in the editor gutter']);
					choice('hunkStatusBar',['状态栏行改动','Line changes in the status bar'],{disabled:t('关闭','Off'),plain:t('单色','Monochrome'),colored:t('按改动类型着色','Color by change type')});
					toggle('hunkCommands',['差异块操作','Hunk actions'],['在差异视图中逐块暂存或取消暂存。','Stage or unstage individual hunks in the diff view.']);
					toggle('lineAuthor',['行作者信息','Line author information'],['使用原生 Git 在编辑器行旁显示提交作者，支持光标行作者查询命令。','Show line authors in the editor gutter and enable the current line author command using native Git.']);
					toggle('blameHash',['显示提交哈希','Show commit hash']);
					toggle('blameIgnoreWhitespace',['忽略行内空白改动','Ignore whitespace changes']);
					choice('blameFollow',['追溯移动与复制','Trace moved and copied lines'],{inactive:t('关闭','Off'),'same-commit':t('同次提交','Same commit'),'all-commits':t('所有提交','Across commits')});
					choice('blameAuthor',['作者姓名','Author name'],{hidden:t('隐藏','Hide'),initials:t('首字母','Initials'),first:t('名字首段','First name'),last:t('名字末段','Last name'),full:t('全名','Full name')});
					choice('blameDate',['作者日期','Author date'],{hidden:t('隐藏','Hide'),date:t('日期','Date'),datetime:t('日期及时间','Date and time'),relative:t('相对时间','Relative time'),custom:t('自定义','Custom')});
					text('blameFormat',['自定义日期格式','Custom date format']);
					choice('blameTimezone',['时区','Time zone'],{viewer:t('查看者所在时区','Local time'),author:t('提交作者所在时区','Author time'),utc:'UTC'});
					row('blameMaxDays',['颜色渐变时长（天）','Coloring age range (days)']).addText(input => {
						input.inputEl.type='number'; input.inputEl.min='1'; input.setValue(String(value('blameMaxDays'))).onChange(s => set('blameMaxDays',Number(s)));
					});
					for (const [key,label] of [['blameOld',['旧提交颜色','Old commit color']],['blameNew',['新提交颜色','New commit color']]] as const)
						row(key,label).addColorPicker(input => input.setValue(value(key)).onChange(s => set(key,s)));
					text('blameText',['行作者文字颜色','Line author text color'],['使用 #RRGGBB 或 var(--text-muted)。','Use #RRGGBB or var(--text-muted).']);
					break;
				case 'views':
					toggle('refreshSourceControl',['文件变化后自动刷新 Git 状态','Refresh Git status after file changes']);
					row('refreshSourceControlTimer',['刷新延时（毫秒）','Refresh delay (milliseconds)'],['最短 500 毫秒。','Minimum 500 milliseconds.'])
						.addText(input => {
							input.inputEl.type='number'; input.inputEl.min='500';
							input.setValue(String(value('refreshSourceControlTimer'))).onChange(s => set('refreshSourceControlTimer',Number(s)));
						});
					toggle('tree',['以目录树显示改动','Show changes as a tree']);
					choice('diffStyle',['差异视图','Diff style'],{split:t('并排','Side by side'),unified:t('统一','Unified')});
					row('diffTimeout',['差异计算时限（毫秒）','Diff computation timeout (milliseconds)'])
						.addText(input => {
							input.inputEl.type='number'; input.inputEl.min='1'; input.inputEl.max='10000';
							input.setValue(String(value('diffTimeout'))).onChange(s => set('diffTimeout',Number(s)));
						});
					choice('historyAuthor',['历史中的作者姓名','Author in history'],{hidden:t('隐藏','Hide'),initials:t('首字母','Initials'),full:t('全名','Full name')});
					toggle('historyDate',['历史中显示日期','Show date in history']);
					break;
				case 'interface':
					toggle('showInfoNotices',['显示 Git 信息通知','Show informational Git notices']);
					toggle('showErrorNotices',['显示 Git 错误通知','Show Git error notices']);
					toggle('showNoChangesNotices',['没有改动时显示通知','Show notices when nothing has changed']);
					toggle('showFileMenu',['在文件菜单显示 Git 状态','Show Git status in the file menu']);
					toggle('showStatusBar',['显示知识库状态栏','Show library status bar']);
					toggle('showBranchStatusBar',['在状态栏显示分支','Show branch in the status bar']);
					toggle('changedFilesInStatusBar',['在状态栏显示变更文件数','Show changed file count in the status bar']);
					break;
				case 'identity':
					text('author',['本地提交作者','Commit author']); text('email',['提交邮箱','Commit email']);
					note('远端凭据请在具体知识库的 Git 状态面板设置。','Set remote credentials in the Git status panel for the individual library.');
					break;
				case 'advanced':
					if (!id) new Setting(inputs).setName(t('在本设备暂停知识库 Git','Pause library Git on this device'))
						.setDesc(t('立即暂停本设备的 Git 工具和自动任务。目录管理及本页始终可用。','Immediately pause Git actions and automation on this device. Folder management and this settings page remain available.'))
						.addToggle(input => input.setValue(gitDisabled(plugin)).onChange(async disabled => {
							try { await setDeviceGitDisabled(plugin,disabled); }
							catch (error) { new Notice(String(error)); }
						}));
					choice('backend',['Git 后端','Git backend'],{builtin:t('内置','Built-in'),native:t('系统 Git','System Git')},
						['原生后端需要本机安装 Git。','The native backend requires Git on this device.']);
					note('操作限定在当前知识库和库内 .git。自定义 shell 脚本、任意命令和仓库路径覆盖已禁用。','Operations use the library and its own .git directory. Custom shell scripts, raw commands and repository path overrides are disabled.');
					new Setting(inputs).setName(t('调试信息','Debug information')).setDesc(t('复制版本、平台、后端和库数量。','Copy the version, platform, backend and library counts.'))
						.addButton(button => button.setButtonText(t('复制','Copy')).onClick(async() => {
							try {
								await navigator.clipboard.writeText(JSON.stringify(diagnostics(plugin,id),null,2));
								new Notice(t('已复制调试信息','Debug information copied'));
							} catch(error) { new Notice(String(error)); }
						}));
					note('查看运行日志可打开 Obsidian 开发者工具的 Console。','Open Console in Obsidian Developer Tools to inspect runtime logs.');
					break;
			}
		};
		draw();
		this.save(async () => {
			if (lib) await recheck(plugin.disk,plugin.config,lib);
			const delay = draft.refreshSourceControlTimer;
			if (draft.blameMaxDays !== undefined && (!Number.isSafeInteger(draft.blameMaxDays) || draft.blameMaxDays < 1))
				throw new Error(t('请输入正整数天数。','Enter a positive number of days.'));
			if (draft.blameText !== undefined && draft.blameText !== gitDefaults.blameText && !/^#[0-9a-f]{6}$/iu.test(draft.blameText))
				throw new Error(t('文字颜色须为 #RRGGBB 或 var(--text-muted)。','Enter #RRGGBB or var(--text-muted) as the text color.'));
			const timeout = draft.diffTimeout;
			if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000))
				throw new Error(t('差异计算时限须在 1 至 10000 毫秒之间。','Enter a diff time limit between 1 and 10000 milliseconds.'));
			if (delay !== undefined && (!Number.isInteger(delay) || delay < 500 || delay > 2147483647))
				throw new Error(t('刷新延时须在 500 至 2147483647 毫秒之间。','Enter a refresh delay between 500 and 2147483647 milliseconds.'));
			for (const interval of [draft.autoCommitMinutes,draft.autoPushMinutes,draft.autoPullMinutes]) {
				if (interval !== undefined && (!Number.isSafeInteger(interval) || interval < 0))
					throw new Error(t('间隔必须是非负整数。','Enter a nonnegative whole number for each interval.'));
			}
			// Update only controls edited on this page; another open settings surface may have saved other fields.
			const merged = {...source()};
			for (const key of touched) {
				if (key in draft) Object.assign(merged,{[key]:draft[key]});
				else delete merged[key];
			}
			if (id) plugin.prefs.libraries[id] = merged;
			else plugin.prefs.defaults = merged;
		});
	}

	private folders() {
		const {plugin,el} = this;
		const draft = {parents:[...plugin.config.parents],templates:[...plugin.config.templates]};
		for (const [field,label,desc] of [
			['parents',['知识库父目录','Library parent folders'],['每行一个 Vault 相对路径，首行是创建知识库的默认位置。','One vault-relative path per line. New libraries default to the first folder.']],
			['templates',['目录模板','Folder templates'],['每行一个模板目录的 Vault 相对路径。','One vault-relative template folder per line.']],
		] as const) new Setting(el).setName(plugin.t(label[0],label[1])).setDesc(plugin.t(desc[0],desc[1]))
			.addTextArea(input => input.setValue(draft[field].join('\n')).onChange(s => {
				draft[field] = s.split('\n').map(line => line.trim()).filter(Boolean);
			}));
		this.save(async () => {
			validateFolders(plugin.disk,draft.parents,draft.templates);
			for (const name of [...draft.parents,...draft.templates]) await plugin.disk.path(name);
			Object.assign(plugin.config,draft);
		});
	}

	private save(apply: () => Promise<void>) {
		const {plugin} = this;
		new Setting(this.el).addButton(button => button.setCta().setButtonText(plugin.t('保存设置','Save settings'))
			.onClick(async () => {
				button.setDisabled(true);
				try {
					await apply(); await plugin.persist(); await plugin.refresh(); this.render();
					new Notice(plugin.t('设置已保存','Settings saved'));
				} catch (error) { new Notice(String(error)); }
				finally { button.setDisabled(false); }
			}));
	}
}

export class ManagerSettings extends PluginSettingTab {
	constructor(private manager: KnowledgeBaseManager) {
		super(manager.app,manager);
	}
	display() {
		new SettingsPages(this.manager,this.containerEl).render();
	}
}

export function librarySettings(plugin: KnowledgeBaseManager, lib: Library) {
	if (!lib.identity || lib.duplicate || lib.problem) return;
	const modal = new Modal(plugin.app);
	modal.setTitle(plugin.t('本库 Git 设置','Library Git settings') + ' · ' + lib.identity.displayName);
	new SettingsPages(plugin,modal.contentEl,lib).render();
	modal.open();
}
