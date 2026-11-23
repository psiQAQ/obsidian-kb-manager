# Obsidian Git 移植对照

对照对象为参考子模块中的 Obsidian Git 2.43.0，提交 `8d1144aef2d41ffca6245a60199656e7a0c5ab17`。本插件按知识库 ID 选择仓库。下表记录源码中的功能入口，桌面实测与自动化测试结果另行记录。[上游快照](https://github.com/Vinzent03/obsidian-git/tree/8d1144aef2d41ffca6245a60199656e7a0c5ab17)

**已接入**表示可从当前界面执行对应操作。**部分对应**表示入口、行为或支持的参数有差异。**边界限制**表示受本插件固定仓库边界约束。**待实现**表示当前版本没有该项完整能力。

## 设置

在 **设置 → Knowledge Base Manager** 配置全局默认值；从知识库行的 **本库 Git 设置** 覆盖或恢复继承。远端、分支及凭据从本库 Git 状态面板管理。以下标识为上游设置名，可与其源码逐项对照。[上游设置页](https://github.com/Vinzent03/obsidian-git/blob/8d1144aef2d41ffca6245a60199656e7a0c5ab17/src/setting/settings.ts)

| 分类 | 上游设置或操作 | 状态及本插件行为 |
|---|---|---|
| 自动化 | `autoSaveInterval`、`autoPullInterval`、`autoPushInterval` | 已接入。分别为提交、拉取和推送设置分钟数，须在本库面板确认授权。 |
| 自动化 | `differentIntervalCommitAndPush` | 部分对应。始终使用独立间隔。 |
| 自动化 | `autoCommitMessage`、`customMessageOnAutoBackup` | 部分对应。提供自动提交说明模板，后台运行时不弹出编辑框。 |
| 自动化 | `autoBackupAfterFileChange`、`setLastSaveToLastCommit`、`autoCommitGlobMode`、`autoCommitGlobs` | 已接入。支持停止编辑后提交、按上次提交起算和逐库 glob。修改范围后须重新授权。 |
| 提交 | `commitMessage`、`commitDateFormat`、设备设置 `hostname`、预览提交说明 | 已接入。支持 `{{date}}`、`{{hostname}}`、`{{files}}` 和 `{{numFiles}}`。 |
| 提交 | `autoStageOnEmptyIndex` | 已接入。控制空索引时是否预览再暂存；已有暂存时仅提交当前索引。 |
| 提交 | `listChangedFilesInMessageBody` | 已接入。允许将提交涉及的文件名追加到正文。 |
| 提交 | `commitMessageScript` | 边界限制。提交说明使用占位符模板，禁用 shell 脚本。 |
| 同步 | `syncMethod` | 部分对应。内置后端支持快进；原生后端另支持合并和变基。自动拉取使用快进。没有仅移动 HEAD 的同步模式。 |
| 同步 | `autoPullOnBoot` | 已接入。已授权库可在启动时拉取。 |
| 同步 | `rebaseAutoStash` | 边界限制。变基要求干净的工作区和索引，不自动储藏或恢复用户修改。 |
| 同步 | `mergeStrategy` | 已接入。原生手动合并可选择 Git 默认、倾向本地或倾向远端。 |
| 同步 | `disablePush`、`pullBeforePush` | 已接入。可设置提交并同步时是否拉取、跳过推送。 |
| 同步 | `squashCommitsBeforePush` | 已接入。提交并同步流程可预览待推送的提交、选择是否合并，并保留旧提交的本地引用。 |
| 编辑器 | `conflictResolutionMode` | 已接入。可在源码、实时预览或两种编辑模式显示冲突块操作，支持标准与 diff3 标记。选择一方后只修改当前编辑缓冲区。解决结果仍需明确暂存。 |
| 编辑器 | `hunks.hunkCommands`、`hunks.showSigns` | 已接入。差异块预览、暂存和编辑器行旁改动标记。 |
| 编辑器 | `hunks.statusBar` | 已接入。状态栏按新增、修改、删除分别计数，可选择关闭、单色或按改动类型着色。 |
| 编辑器 | `lineAuthor.show`、`lineAuthor.showCommitHash`、`lineAuthor.followMovement`、`lineAuthor.authorDisplay`、`lineAuthor.dateTimeFormatOptions`、`lineAuthor.dateTimeFormatCustomString`、`lineAuthor.dateTimeTimezone`、`lineAuthor.ignoreWhitespace` | 已接入逐行作者边栏。原生后端对当前库内文件的编辑缓冲区运行 blame，显示作者、日期及提交，尚未提交的新行留空。 |
| 编辑器 | `lineAuthor.coloringMaxAge`、`lineAuthor.colorOld`、`lineAuthor.colorNew`、`lineAuthor.textColorCss` | 部分对应。渐变时长以天为单位；背景色用十六进制色值，文字色可用主题默认值。 |
| 视图 | `treeStructure`、`diffStyle`、`dateInHistoryView` | 已接入。可选树形或列表、并排或统一差异、历史日期显隐。 |
| 视图 | `authorInHistoryView` | 已接入。历史作者可显示全名、首字母或隐藏。 |
| 视图 | `refreshSourceControl`、`refreshSourceControlTimer` | 已接入。展开库的可见文件创建、删除、修改及改名后，等待配置的延时刷新。输入提交说明期间延后刷新。 |
| 视图 | `diffTimeout` | 已接入。差异与差异块计算有 1～10000 毫秒的可调时限。 |
| 界面 | `showFileMenu` | 已接入。决定知识库文件右键菜单是否提供本库 Git 状态入口。 |
| 界面 | `disablePopups`、`showErrorNotices`、`disablePopupsForNoChanges` | 已接入。可控制 Git 信息、错误、无改动通知。上游界面也使用 `showInformationalNotifications`、`showNoChangesNotifications` 两个反向显示键。对话框内的操作结果独立展示。 |
| 界面 | `showStatusBar`、`showBranchStatusBar`、`changedFilesInStatusBar` | 已接入。状态栏跟随当前文件所属库，分支和变更数量可独立控制。 |
| 身份 | `user.name`、`user.email` | 从本库 `.git/config` 读取，设置修改也写回本库。桌面按字段继承系统 Git 的有效配置，清空库内覆盖后恢复继承。若 Git 的作者或提交者单独覆盖了预览身份，须在命令行完成本次提交。 |
| 身份 | `username`、`gitServerPasswordSecret` | 桌面 HTTPS 默认交给系统凭据助手，SSH 使用系统 SSH。可按库和 HTTPS 远端明确选用 SecretStorage 备用凭据。 |
| 高级 | `limitToVault`、`basePath`、`gitDir` | 边界限制。仓库位置来自已验证的知识库，Git 元数据固定在该库的 `.git`。 |
| 高级 | `updateSubmodules`、`submoduleRecurseCheckout` | 边界限制。不递归操作嵌套仓库。 |
| 高级 | `gitPath`、`PATHPaths`、`envVars`、重载环境 | 部分对应。桌面使用系统 Git；可在高级设置中指定本机的 Git 可执行文件绝对路径。可重定向仓库的环境变量受限。 |
| 高级 | `pluginDisabled`、复制调试信息、调试日志 | 部分对应。在本设备暂停知识库 Git 并保留管理器设置入口。可查看包含版本、平台、后端和库数量的只读 JSON，选中后用系统复制命令取用。报告省略原始路径、内容和凭据。 |

上游还包含已废弃的 `mergeOnPull`、`autoCommitOnlyStaged`、明文 `password` 迁移和移动端标记 `showedMobileNotice`。本插件在桌面独立保存设置，不导入另一插件的数据。上游的支持与捐助链接可在其项目页查看。

## 命令

这里按上游命令 ID 列出操作对应关系。知识库管理器使用自己的命令 ID，部分操作仅通过当前库的行内按钮提供。[上游命令定义](https://github.com/Vinzent03/obsidian-git/blob/8d1144aef2d41ffca6245a60199656e7a0c5ab17/src/commands.ts)

| 上游命令 ID | 状态及本插件入口 |
|---|---|
| `open-git-view`、`list-changed-files` | 已接入。打开管理器，在知识库行展开 Git 状态。 |
| `open-history-view`、`open-diff-view` | 已接入。点历史图标或具体文件，查看该库提交与差异。 |
| `stage-current-file`、`unstage-current-file` | 已接入。当前文件命令、文件行和分组工具栏都按库执行。 |
| `commit-smart`、`commit-smart-specified-message` | 已接入。在行内输入说明，使用保存版本预览，按索引状态选择提交范围。 |
| `commit`、`commit-specified-message`、`commit-staged`、`commit-staged-specified-message` | 已接入。更多提交操作中可明确选择提交全部或仅提交索引，提交前可预览并编辑说明。 |
| `commit-amend-staged-specified-message` | 已接入。更多提交操作中可预览并修订当前提交。 |
| `pull`、`fetch`、`push2` | 已接入。本库工具栏的拉取、获取、推送。手动拉取分为获取预览与应用两个步骤。 |
| `push`、`commit-push-specified-message` | 已接入。本库提交并同步分步确认，单独推送对应 `push2`。 |
| `backup-and-close` | 部分对应。**同步后关闭当前笔记** 先预览本库提交和同步，成功后关闭发起命令的笔记。Vault 和其他库继续打开。 |
| `switch-branch`、`create-branch`、`set-upstream-branch` | 已接入。在分支菜单创建或切换本地分支，在远端设置指定上游。 |
| `delete-branch`、`switch-to-remote-branch` | 部分对应。可删除已合并且非当前的本地分支。选定远端分支后先创建并绑定本地跟踪分支，再预览并切换。 |
| `edit-remotes` | 部分对应。可以新增远端、选择上游。同名远端的 URL 变化需要核对。 |
| `remove-remote` | 已接入。预览会列出相关本地分支与跟踪引用。 |
| `init-repo` | 已接入。在已接管且缺少 Git 的库内初始化。 |
| `clone-repo` | 已接入。克隆知识库到新目录，确认身份、分支和文件清单后发布到选定父目录。 |
| `delete-repo` | 边界限制。插件保留库内既有 Git 历史，不提供删除整个仓库的命令。 |
| `discard-all` | 部分对应。对单个文件预览后丢弃工作区改动，未跟踪文件使用 Obsidian 回收站。 |
| `edit-gitignore`、`add-to-gitignore` | 已接入。预览本库忽略规则后可保存或加入当前文件。 |
| `view-file-on-github`、`view-history-on-github` | 已接入。按本库绑定的 GitHub 上游打开文件或历史。 |
| `pause-automatic-routines` | 部分对应。从本库自动化面板撤销授权或重新授权，授权目标变化后会暂停。 |
| `raw-command` | 边界限制。仅接受结构化操作。 |
| `toggle-line-author-info` | 部分对应。设置中打开或关闭逐行作者信息；另有查询当前行作者的命令。 |
| `stage-hunk`、`preview-hunk`、`reset-hunk`、`next-hunk`、`prev-hunk` | 已接入。启用本库差异块命令后可从编辑器处理光标处差异块。 |

库边界、索引和网络操作采用本插件的服务层。界面文案、身份数据和默认值由本插件维护，因此升级时无需迁移上游工作区设置或命令快捷键。
