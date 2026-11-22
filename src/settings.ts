import { Notice, PluginSettingTab, Setting, SettingGroup, moment } from 'obsidian';
import type { SettingDefinitionItem, SettingDefinitionRender, SettingGroupItem } from 'obsidian';
import { deviceGitPath, saveDeviceGitPath } from './ui/git-path.ts';
import { hostname } from 'node:os';
import type KnowledgeBaseManager from './main.ts';
import { validateFolderSettings } from './registry/paths.ts';
import { discover, identityFile, recheck } from './kb/catalog.ts';
import type { Library } from './kb/catalog.ts';
import type { GitPreferences, Language } from './preferences.ts';
import { gitDefaults, renderCommitMessage } from './preferences.ts';
import { diagnostics, gitDisabled, setDeviceGitDisabled } from './ui/device.ts';
import { editRepositoryIdentity } from './ui/repository-identity.ts';
import { Dialog, V3Dialog, showJsonPreview } from './ui/dialog.ts';
import { addTextField } from './ui/text-field.ts';
import { makeTemplateWizard } from './ui/v3-template-author.ts';

const categories = {
	folders: ['知识库目录与模板', 'Library folders and templates'],
	automatic: ['自动化', 'Automatic'],
	commit: ['提交', 'Commit'],
	sync: ['同步', 'Sync'],
	editor: ['编辑器', 'Editor'],
	views: ['视图', 'Views'],
	interface: ['界面', 'Interface'],
	identity: ['提交身份', 'Commit identity'],
	advanced: ['高级', 'Advanced'],
} as const;
type Category = keyof typeof categories;
type Label = readonly [string,string];
type BooleanKey = { [K in keyof GitPreferences]: GitPreferences[K] extends boolean ? K : never }[keyof GitPreferences];
type ChoiceKey = { [K in keyof GitPreferences]: GitPreferences[K] extends string ? string extends GitPreferences[K] ? never : K : never }[keyof GitPreferences];

type PreferenceCategory = Exclude<Category,'folders'|'identity'>;

function stateForGroup<T extends object>(create: () => T) {
	const states = new WeakMap<SettingGroup,T>();
	return (group: SettingGroup) => {
		let state = states.get(group);
		if (!state) {
			state = create();
			states.set(group,state);
		}
		return state;
	};
}

function preferenceSettings(plugin: KnowledgeBaseManager, page: PreferenceCategory, refresh: () => void, lib?: Library) {
	const t = plugin.t;
	const id = lib?.identity?.id;
	const source = () => (id ? plugin.prefs.libraries[id] : plugin.prefs.defaults) ?? {};
	const form = stateForGroup(() => {
		const draft = {...source()};
		const touched = new Set<keyof GitPreferences>();
		const inherited = id ? plugin.preferences() : gitDefaults;
		const value = <K extends keyof GitPreferences>(key: K) => draft[key] ?? inherited[key];
		const set = <K extends keyof GitPreferences>(key: K, next: GitPreferences[K]) => {
			draft[key] = next; touched.add(key);
		};
		const clear = (key: keyof GitPreferences) => { delete draft[key]; touched.add(key); };
		const inputValue = (key: keyof GitPreferences) => String(draft[key] ?? '');
		const updateInput = <K extends keyof GitPreferences>(key: K, raw: string, parsed: GitPreferences[K]) => {
			if (raw !== '') set(key,parsed);
			else clear(key);
		};
		const example = (key: keyof GitPreferences, fallback: string) => String(inherited[key] || fallback);
		return { draft,touched,value,set,clear,inputValue,updateInput,example,executable:undefined as string|undefined };
	});
	const items:SettingDefinitionRender[] = [];
	type Configure = (setting: Setting, state: ReturnType<typeof form>) => Setting | void;
	const add = (label: Label, configure: Configure, description?: Label) => {
		items.push({name:t(...label),desc:description ? t(...description) : undefined,
			render(setting,group) { configure(setting,form(group)); }});
	};
	const row = (key: keyof GitPreferences, label: Label, configure: Configure, description?: Label) => {
		add(label,(setting,state) => {
			const draw = () => {
				if (id) {
					const inherited = state.draft[key] === undefined ? t('继承全局默认值','Inherits global default') : t('本库覆盖值','Library override');
					setting.setDesc(description ? inherited+' · '+t(...description) : inherited);
					if (key in state.draft) setting.addExtraButton(button => button.setIcon('reset')
						.setTooltip(t('恢复继承','Use global default')).onClick(() => {
							state.clear(key); setting.clear(); draw();
						}));
				}
				configure(setting,state);
			};
			draw();
		},description);
	};
	const text = (key: 'commitMessage'|'autoCommitMessage'|'commitDateFormat'|'commitHostname'|'blameFormat'|'autoGlobs'|'blameText',
		label: Label, fallback: string, desc?: Label, multiline = false) =>
		row(key,label,(setting,state) => addTextField(setting,state.inputValue(key),s => state.updateInput(key,s,s),
			{example:state.example(key,fallback)},multiline),desc);
	const number = (key: 'autoCommitMinutes'|'autoPullMinutes'|'autoPushMinutes'|'blameMaxDays'|'refreshSourceControlTimer'|'diffTimeout',
		label: Label, desc?: Label) =>
		row(key,label,(setting,state) => addTextField(setting,state.inputValue(key),s => state.updateInput(key,s,/^[0-9]+$/u.test(s)?Number(s):NaN),
			{example:state.example(key,'0'),numeric:true}),desc);
	const toggle = (key: BooleanKey, label: Label, desc?: Label) =>
		row(key,label,(setting,state) => setting.addToggle(input => input.setValue(state.value(key)).onChange(b => state.set(key,b))),desc);
	const choice = <K extends ChoiceKey>(key: K, label: Label, options: Record<GitPreferences[K],string>, desc?: Label) =>
		row(key,label,(setting,state) => setting.addDropdown(input => input.addOptions(options).setValue(state.value(key))
			.onChange(s => state.set(key,s as GitPreferences[K]))),desc);
	const note = (zh: string,en: string) => items.push({name:'',searchable:false,
		render(setting) { setting.descEl.createEl('p',{text:t(zh,en)}); }});

	switch (page) {
		case 'automatic':
			note('0 表示关闭。在本库的 Git 工作区 → 远端与分支确认授权后，此设备才会执行自动操作。',
				'Zero disables a timer. This device starts automation after you authorize it under Git workspace → Remote and branches.');
			text('autoCommitMessage',['自动提交说明模板','Auto commit message template'],t('知识库备份 · {{date}}','Knowledge base backup · {{date}}'),
				['支持与手动提交相同的占位符。','Accepts the same placeholders as a manual commit.'],true);
			toggle('autoAfterEdits',['等停止编辑后提交','Wait for editing to stop before committing']);
			toggle('autoFromLastCommit',['从最后一次提交开始计时','Start the timer from the latest commit']);
			toggle('autoPullOnStart',['启动时拉取','Pull on startup']);
			choice('autoGlobMode',['自动提交文件匹配方式','Auto commit glob mode'],{include:t('仅包含匹配项','Include matching paths'),exclude:t('排除匹配项','Exclude matching paths')});
			text('autoGlobs',['自动提交文件匹配规则','Auto commit globs'],'Notes/**/*.md',
				['每行一个相对于本库的 glob 表达式。','Enter one library-relative glob per line.'],true);
			for (const [key,label] of [
				['autoCommitMinutes',['自动提交间隔（分钟）','Auto commit interval (minutes)']],
				['autoPullMinutes',['自动拉取间隔（分钟）','Auto pull interval (minutes)']],
				['autoPushMinutes',['自动推送间隔（分钟）','Auto push interval (minutes)']],
			] as const) number(key,label);
			break;
		case 'commit':
			toggle('autoStageOnEmptyIndex',['索引为空时暂存并提交全部改动','Stage all changes when nothing is staged']);
			toggle('listChangedFilesInMessageBody',['在提交正文列出变更文件','List changed files in the commit body']);
			text('commitMessage',['手动提交说明模板','Manual commit message template'],t('更新 {{numFiles}} 个文件 · {{date}}','Update {{numFiles}} files · {{date}}'),
				['支持 {{date}}、{{hostname}}、{{files}} 和 {{numFiles}}，提交前可以编辑。','Use {{date}}, {{hostname}}, {{files}} and {{numFiles}}. You can edit the result before committing.'],true);
			text('commitDateFormat',['日期格式','Date format'],'YYYY-MM-DD HH:mm:ss');
			text('commitHostname',['主机名替换文本','Hostname replacement'],'laptop',['留空使用本机名称。','Leave empty to use this device’s hostname.']);
			add(['预览提交说明','Preview commit message'],(setting,{value}) => setting.addButton(button => button.setButtonText(t('预览','Preview')).onClick(() => {
					const example = renderCommitMessage({commitMessage:value('commitMessage'),commitHostname:value('commitHostname')},
						moment.utc().local().format(value('commitDateFormat')),hostname(),['Notes/example.md']);
					const preview=new Dialog(plugin.app,t('预览提交说明','Preview commit message'));
					preview.facts([[t('提交说明','Commit message'),example || t('提交时手动填写','Enter manually when committing')]]);
					preview.open();
				})));
			break;
		case 'sync':
			toggle('squashCommitsBeforePush',['推送前合并未推送的提交','Squash unpushed commits before pushing'],['提交并同步时，复核上游之后的本地线性提交。','Review the local commits after the upstream tip when committing and syncing.']);
			toggle('pullBeforePush',['提交并同步时拉取','Pull on commit and sync']);
			toggle('disablePush',['提交并同步时跳过推送','Skip push on commit and sync']);
			choice('syncMethod',['拉取策略','Pull strategy'],{
				'ff-only':t('仅快进','Fast-forward only'),merge:t('合并','Merge'),rebase:t('变基','Rebase'),
			},['合并和变基需要原生 Git。远端与上游分支在本库的 Git 工作区 → 远端与分支设置。',
				'Merge and rebase require native Git. Configure the remote and upstream under Git workspace → Remote and branches.']);
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
			text('blameFormat',['自定义日期格式','Custom date format'],'YYYY-MM-DD HH:mm');
			choice('blameTimezone',['时区','Time zone'],{viewer:t('查看者所在时区','Local time'),author:t('提交作者所在时区','Author time'),utc:'UTC'});
			number('blameMaxDays',['颜色渐变时长（天）','Coloring age range (days)']);
			for (const [key,label] of [['blameOld',['旧提交颜色','Old commit color']],['blameNew',['新提交颜色','New commit color']]] as const)
				row(key,label,(setting,state) => setting.addColorPicker(input => input.setValue(state.value(key)).onChange(s => state.set(key,s))));
			text('blameText',['行作者文字颜色','Line author text color'],gitDefaults.blameText,
				['输入 #RRGGBB，或用 var(--text-muted) 跟随主题的次要文字颜色。','Enter #RRGGBB or use var(--text-muted) to follow the theme’s muted text color.']);
			break;
		case 'views':
			toggle('refreshSourceControl',['自动刷新 Git 状态','Refresh Git status automatically'],
				['库内文件变化或切回 Obsidian 窗口时检查。','Check after library file changes or when returning to an Obsidian window.']);
			number('refreshSourceControlTimer',['刷新延时（毫秒）','Refresh delay (milliseconds)'],['最短 500 毫秒。','Minimum 500 milliseconds.']);
			toggle('tree',['以目录树显示改动','Show changes as a tree']);
			choice('diffStyle',['差异视图','Diff style'],{split:t('并排','Side by side'),unified:t('统一','Unified')});
			number('diffTimeout',['差异计算时限（毫秒）','Diff computation timeout (milliseconds)']);
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
		case 'advanced':
			if (!id) {
				add(['在本设备暂停知识库 Git','Pause library Git on this device'],
					setting => setting.addToggle(input => input.setValue(gitDisabled(plugin)).onChange(async disabled => {
						try { await setDeviceGitDisabled(plugin,disabled); }
						catch (error) { new Notice(String(error)); }
					})), ['立即暂停本设备的 Git 工具和自动任务。目录管理及本页始终可用。','Immediately pause Git actions and automation on this device. Folder management and this settings page remain available.']);
				add(['本机 Git 可执行文件','Git executable on this device'],(setting,state) =>
					setting.addText(input => input.setPlaceholder(t('可留空，跟随系统默认','Optional · use system default'))
						.setValue(state.executable ?? deviceGitPath(plugin)).onChange(path => { state.executable = path; })),
					['Windows 可运行 where.exe git 查看已安装的位置。','On Windows, use where.exe git to find the installed executable.']);
			}
			note('操作限定在当前知识库和库内 .git。自定义 shell 脚本、任意命令和仓库路径覆盖已禁用。','Operations use the library and its own .git directory. Custom shell scripts, raw commands and repository path overrides are disabled.');
			add(['调试信息','Debug information'],setting => setting.addButton(button => button.setButtonText(t('查看','View')).onClick(() => {
				showJsonPreview(plugin.app,t('调试信息','Debug information'),diagnostics(plugin));
			})), ['查看版本、平台、后端和库数量。','View the version, platform, backend and library counts.']);
			note('查看运行日志可打开 Obsidian 开发者工具的 Console。','Open Console in Obsidian Developer Tools to inspect runtime logs.');
			break;
	}
	items.push({name:'',searchable:false,render(setting,group) {
		renderSave(plugin,setting,refresh,async () => {
			if (lib) await recheck(plugin.disk,plugin.config,lib);
			const {draft,touched,executable} = form(group);
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
			if (executable !== undefined) await saveDeviceGitPath(plugin,executable);
			const merged:Partial<GitPreferences> = {};
			const remove:(keyof GitPreferences)[]=[];
			for (const key of touched) {
				if (key in draft) Object.assign(merged,{[key]:draft[key]});
				else remove.push(key);
			}
			if (id && lib && touched.size) {
				const overrides={...source(),...merged};
				for(const key of remove)delete overrides[key];
				await plugin.saveLibraryPreferences(lib,overrides);
			} else if (!id && touched.size) {
				await plugin.saveSharedPreferences({defaults:merged,remove});
			}
		});
	}});
	return items;
}

async function pendingMigration(plugin: KnowledgeBaseManager, refresh: () => void) {
	const t=plugin.t;
	const libraries=await discover(plugin.disk,plugin.config);
	const pending=Object.keys(plugin.pendingLibraryPreferences).sort();
	const dialog=new Dialog(plugin.app,t('迁移旧版每库设置','Migrate legacy library preferences'));
	const source=(plugin.manifest.dir??plugin.app.vault.configDir+'/plugins/'+plugin.manifest.id)+'/data.json';
	dialog.lines([t('来源','Source')+' · '+source+' → prefs.libraries',
		t('请登记带原 ID 的 kb.toml。迁移值保存在本设备，确认后写入所选库。','Register kb.toml with the original ID. The saved values stay on this device until you confirm the migration.')]);
	for(const id of pending) {
		const matches=libraries.filter(lib=>lib.identity?.id===id);
		const lib=matches[0];
		const available=matches.length===1 && !!lib?.signature && !lib.problem && !lib.duplicate && !lib.identity?.archived;
		const row=new Setting(dialog.contentEl).setName(lib?.identity?.displayName??id)
			.setDesc([id,...matches.map(item=>item.location),
				available?'':t('等待登记唯一且可写的同 ID 知识库','Waiting for a unique, writable library with the same ID')].filter(Boolean).join(' · '));
		if(available)row.addButton(button=>button.setButtonText(t('预览','Preview')).onClick(async()=>{
			try {
				const preview=await plugin.previewPendingPreferences(id);
				const confirm=new Dialog(plugin.app,t('确认迁移每库设置','Confirm migration of library preferences'));
				confirm.lines([source+' · prefs.libraries.'+id,
					preview.target.location+'/'+identityFile+' · [preferences]',
					t('已设置的同名字段将采用下方列出的迁移值。','Fields already set will take the migrated values shown below.')]);
				const fields=Object.keys(preview.previous) as (keyof GitPreferences)[];
				confirm.lines(fields.map(field=>{
					const from=preview.target.preferences?.[field];
					return field+' · '+(from===undefined?t('继承全局','Inherited'):JSON.stringify(from))+' → '+JSON.stringify(preview.previous[field]);
				}));
				confirm.action(t('写入清单','Apply to manifest'),async()=>{
					await plugin.applyPendingPreferences(id,preview);
					confirm.close();dialog.close();await plugin.refresh();refresh();
				});
				confirm.open();
			}catch(error){new Notice(String(error));}
		}));
	}
	dialog.open();
}

function folderSettings(plugin: KnowledgeBaseManager, refresh: () => void): SettingDefinitionRender[] {
	const t = plugin.t;
	const form = stateForGroup(() => ({
		parents:[...plugin.config.parents],templates:[...plugin.config.templates],
		templateInput:null as HTMLTextAreaElement|null,
	}));
	const folders = [
		['parents',['收藏的父目录','Favorite parent folders'],['每行一个 Vault 相对路径，可留空。收藏目录会显示在位置选择器中。','Optional. Enter one vault-relative path per line. Favorites appear in the location picker.']],
		['templates',['目录模板','Folder templates'],['每行一个模板目录的 Vault 相对路径。','One vault-relative template folder per line.']],
	] as const;
	const items:SettingDefinitionRender[] = folders.map(([field,label,desc]) => ({
		name:t(label[0],label[1]),desc:t(desc[0],desc[1]),
		render(setting,group) {
			const draft = form(group);
			addTextField(setting,draft[field].join('\n'),s=>{draft[field]=s.split('\n').map(line=>line.trim()).filter(Boolean);},
				{example:field==='parents'?'knowledge-base':'templates/wiki'},true);
			if (field==='templates') draft.templateInput=setting.controlEl.querySelector('textarea');
		},
	}));
	items.push({
		name:t('制作模板','Make a template'),
		render(setting,group) {
			const draft = form(group);
			setting.addButton(button=>button.setButtonText(t('打开向导','Open wizard')).onClick(()=>makeTemplateWizard(plugin,source=>{
				if (!draft.templates.includes(source)) draft.templates.push(source);
				if (draft.templateInput) draft.templateInput.value=draft.templates.join('\n');
			})));
		},
	},{
		name:'',searchable:false,
		render(setting,group) {
			renderSave(plugin,setting,refresh,async () => {
				const {parents,templates} = form(group);
				validateFolderSettings(parents,templates,plugin.disk.configDir);
				for (const name of [...parents,...templates]) await plugin.disk.folder(name,true);
				Object.assign(plugin.config,{parents,templates});
				await plugin.persist();
			});
		},
	});
	return items;
}

function renderSave(plugin: KnowledgeBaseManager, setting: Setting, refresh: () => void, apply: () => Promise<void>) {
	setting.setClass('kb-controls-only').addButton(button => button.setCta().setButtonText(plugin.t('保存设置','Save settings'))
		.onClick(async () => {
			button.setDisabled(true);
			try {
				await apply(); await plugin.refresh(); refresh();
				new Notice(plugin.t('设置已保存','Settings saved'));
			} catch (error) { new Notice(String(error)); }
			finally { button.setDisabled(false); }
		}));
}

export class ManagerSettings extends PluginSettingTab {
	constructor(private manager: KnowledgeBaseManager) {
		super(manager.app,manager);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const {manager:plugin} = this;
		const t = plugin.t;
		const refresh = () => this.update();
		const pending = Object.keys(plugin.pendingLibraryPreferences).length;
		const items:SettingGroupItem<string>[] = [{
			name:t('界面语言','Language'),
			render(setting) {
				setting.addDropdown(input => input
					.addOptions({system:t('跟随 Obsidian','Follow Obsidian'),zh:'简体中文',en:'English'})
					.setValue(plugin.prefs.language).onChange(async value => {
						try { await plugin.saveSharedPreferences({language:value as Language}); await plugin.refresh(); refresh(); }
						catch (error) { new Notice(String(error)); }
					}));
			},
		}];
		if (pending) items.push({
			name:t('旧版每库设置','Legacy library preferences'),
			desc:t('待迁移的库数：','Libraries awaiting migration: ')+pending,
			render(setting) {
				setting.addButton(button=>button.setButtonText(t('查看','Review')).onClick(async()=>{
					try { await pendingMigration(plugin,refresh); } catch (error) { new Notice(String(error)); }
				}));
			},
		});
		for (const key of Object.keys(categories) as Category[]) {
			if (key === 'identity') continue;
			const rows = key === 'folders' ? folderSettings(plugin,refresh) : preferenceSettings(plugin,key,refresh);
			const [zh,en] = categories[key];
			const desc = key === 'folders' ? t('保存在此设备','Stored on this device') : key === 'advanced' ?
				t('管理当前设备的 Git、查看调试信息','Manage Git on this device and view debug information') :
				t('适用于继承全局默认值的知识库','Defaults for libraries that inherit these settings');
			items.push({type:'page',name:t(zh,en),desc,items:[{type:'group',cls:'kb-settings',items:rows}]});
		}
		return [{type:'group',cls:'kb-settings',items}];
	}
}

export function librarySettings(plugin: KnowledgeBaseManager, lib: Library) {
	if (!lib.identity || lib.duplicate || lib.problem) return;
	const t = plugin.t;
	const modal = new V3Dialog(plugin.app,t('本库 Git 设置','Library Git settings') + ' · ' + lib.identity.displayName);
	const el = modal.contentEl;
	el.addClass('kb-settings');
	modal.facts([[t('知识库路径','Library path'),lib.location]]);
	type LibraryCategory = Exclude<Category,'folders'>;
	const menu = el.createDiv({cls:'kb-library-settings-menu'});
	const pages = new Map<LibraryCategory,HTMLElement>();
	const goTo = (page?: LibraryCategory, rebuild = false) => {
		if (page && rebuild) { pages.get(page)?.remove(); pages.delete(page); }
		menu.hidden = page !== undefined;
		for (const [key,container] of pages) container.hidden = key !== page;
		if (!page || pages.has(page)) return;
		const container = el.createDiv();
		pages.set(page,container);
		const [zh,en] = categories[page];
		new Setting(container).setName(t(zh,en)).setHeading()
			.addButton(button => button.setButtonText(t('返回分类','Back to categories')).onClick(() => goTo()));
		if (page === 'identity') {
			new Setting(container).setName(t('本库 Git 提交身份','Library Git commit identity')).setDesc(lib.location+'/.git/config')
				.addButton(button=>button.setButtonText(t('查看或修改','View or edit')).onClick(async()=>{
					try { await editRepositoryIdentity(plugin,lib); } catch (error) { new Notice(String(error)); }
				}));
			return;
		}
		container.createEl('p',{cls:'kb-workspace-meta',text:t('本库覆盖值写入 kb.toml 的 [preferences]。其余设置继承全局默认值。',
			'Library overrides are saved in [preferences] in kb.toml. Other values inherit the global defaults.')});
		const group = new SettingGroup(container);
		for (const item of preferenceSettings(plugin,page,() => goTo(page,true),lib)) group.addSetting(setting => {
			setting.setName(item.name).setDesc(item.desc ?? '');
			item.render(setting,group);
		});
	};
	for (const page of Object.keys(categories) as Category[]) {
		if (page === 'folders') continue;
		const [zh,en] = categories[page];
		const name = t(zh,en);
		new Setting(menu).setName(name).addButton(button => {
			const open=t('打开','Open');
			button.buttonEl.setAttribute('aria-label',open+' · '+name);
			button.setButtonText(open).onClick(() => goTo(page));
		});
	}
	modal.open();
}
