# 桌面历史图与 Git Graph 的功能对照

从 **知识库 → Git 工作区 → 历史** 打开已登记知识库的提交图。向下滚动继续浏览；点击一个提交，再按住 Ctrl（macOS 为 Cmd）点击另一个提交，可以查看两者之间的文件变化。图上的菜单始终使用该历史标签所属的知识库。[操作指南](library-git.md)

对照基线为 VS Code Git Graph **v1.30.0**，提交 `881a9e613045bacbbadf8940f6b6c5b8bd699335`。开发者可用 `git submodule update --init references/vscode-git-graph` 获取相同的参考源码。子模块只用于本地核对；生产包检查会拒绝来自 `references/` 的构建输入。上游对衍生作品的分发有限制。[原版功能表](https://github.com/mhutchie/vscode-git-graph/blob/881a9e613045bacbbadf8940f6b6c5b8bd699335/README.md) · [原版许可](https://github.com/mhutchie/vscode-git-graph/blob/881a9e613045bacbbadf8940f6b6c5b8bd699335/LICENSE) · [打包检查](../scripts/package_plugin.py)

## 操作入口与边界

| 用户要做的事 | 本插件的入口、结果与边界 | 实现和验证 |
|---|---|---|
| 看提交图、分支、标签和贮藏 | 当前分支是默认范围。可改选所有引用或指定引用。HEAD、本地、远端跟踪、标签和 stash 分开显示。悬停显示提交信息及直接指向它的引用。要看某个分支是否包含该提交，可选中该分支并查找 SHA。 | [引用快照](../src/git/history-graph.ts) · [原生 Git 对照测试](../tests/history-graph.test.mjs) |
| 浏览与查找 | 列表接近底部时加载更早的提交；查找覆盖所选范围的 SHA、说明、作者、引用名称和显示日期。可定位 HEAD、相邻行和父子提交，或刷新后返回原来的阅读位置。右键可复制完整 SHA、提交标题或引用名。 | [历史页](../src/ui/source-history.ts) · [查找控件](../src/ui/history-search.ts) |
| 比较版本 | 点选提交默认与第一父提交比较，合并提交可指定其他父提交。两个任意提交可直接比较并交换方向；另有空树、当前工作区比较。**工作区更改**和**已暂存的更改**仍分别显示磁盘与索引、索引与 HEAD 的差异。 | [比较端点](../src/git/index-history.ts) · [比较测试](../tests/history-comparison.test.mjs) |
| 查看变更或某一版笔记 | 展开历史详情，选择文件树或列表。改名显示新旧路径；逐文件菜单提供只读快照、打开当前笔记、复制相对路径、和工作文件比较、预览恢复。二进制和过大的文本给出状态。 | [逐文件操作](../src/ui/history-comparison.ts) · [差异与快照](../src/ui/source-diff.ts) |
| 阅读差异、跟踪审阅进度 | 红绿底纹、符号和行号区分增删；工具栏可切换双栏／统一并跳至上一处或下一处变化。固定提交比较的审阅标记按库、比较方向和文件版本在当前设备保存，可撤销；含工作区的比较只供即时阅读。 | [差异控件](../src/ui/diff-table.ts) · [标签复用测试](../tests/source-tabs.test.mjs) |
| 处理本地分支 | 从所点提交建立分支，或在本地分支菜单切换、重命名、删除已合入分支、合并／变基到指定引用。切换和整合前需保存工作区更改。现有侧栏与命令面板入口继续可用。 | [图上菜单](../src/ui/history-actions.ts) · [分支校验](../src/git/network.ts) |
| 标签与贮藏 | 创建轻量／附注标签，读注释、推送或删除指定标签。可以选择是否贮藏未跟踪文件。应用、弹出或从 stash 建分支前检查脏文件和路径重叠；从 stash 建分支会保留原条目。 | [引用操作](../src/git/graph-ref-actions.ts) · [贮藏测试](../tests/graph-ref-actions.test.mjs) |
| 管理远端与同步 | 配置本库远端和跟踪目标，从明确的引用获取或建立跟踪分支。删除远端分支或标签时核对目标端点和预期 OID。清理失效跟踪分支先列候选，仅适用于标准分支映射。带租约强推在确认前后检查所选上游分支。 | [远端菜单](../src/ui/history-remote-actions.ts) · [回环 HTTP 测试](../tests/network.test.mjs) |
| 应用、撤销或丢弃提交 | **更多操作 → 提交与恢复操作** 提供 cherry-pick、revert 和 drop。摘取或撤销合并提交时可选主线父提交。丢弃操作支持当前分支上的非根普通提交，重放范围含合并时提示单独审阅。 | [操作预览](../src/git/history-advanced.ts) · [冲突回归](../tests/history-advanced.test.mjs) |
| reset、clean、分离 HEAD、恢复文件 | 可选 soft／mixed／hard 并核对引用、索引与文件影响。未提交行的 clean 枚举未跟踪文件，排除忽略项、本地清单、日志和检验工具。分离 HEAD 可读图并切回本地分支。恢复历史文件同时更新该路径的暂存区和工作区。 | [操作入口](../src/ui/history-advanced.ts) · [本地管理路径](../src/git/graph-recovery.ts) |
| 解决中断、打开 PR 与议题 | 支持普通 merge、cherry-pick、revert 和普通 rebase 的冲突状态；逐文件确认解决，再继续或中止。带自定义重放指令、特殊仓库布局等情况提示回原 Git 客户端处理。支持按用户点击打开 GitHub、GitLab.com 或 Bitbucket Cloud 的 PR／合并请求和提交说明中的议题编号。 | [恢复状态](../src/git/graph-recovery.ts) · [托管平台链接](../src/git/hosting-links.ts) |

## 上游设置如何对应

下表用 v1.30.0 的设置族名定位原设置。可以在[上游设置清单](https://github.com/mhutchie/vscode-git-graph/blob/881a9e613045bacbbadf8940f6b6c5b8bd699335/package.json)中搜索 `git-graph.` 加设置名，包含历史弃用的别名。插件的显示选项位于图内**显示设置**；仓库默认 Git 行为仍由[本库 Git 设置](library-git.md)管理。

| 上游设置 | 本插件的处理 |
|---|---|
| `commitDetailsView.*`、`defaultColumnVisibility`、`referenceLabels.*` | 可切换文件树／列表、详情下方／侧方、作者／日期／SHA 显隐及宽度、引用标签位置。紧凑目录合并、把同指向的本地与远端引用合为一个标签未提供。 |
| `customBranchGlobPatterns`、`repository.onLoad.*`、`repository.showRemoteBranches`、`repository.showRemoteHeads`、`repository.showTags`、`repository.showCommitsOnlyReferencedByTags`、`repository.showStashes` | 支持选定引用、名称过滤、回 HEAD 和 stash 显隐。只由标签可达的提交可在所有引用或选定标签下查看。自定义 glob 组、远端符号 HEAD 独立标签不是当前筛选选项。 |
| `repository.commits.initialLoad`、`loadMore`、`loadMoreAutomatically`、`order`、`mute.*`、`repository.onlyFollowFirstParent`、`includeCommitsMentionedByReflogs` | 首屏与续载按批读取，长历史只渲染可见区域附近的行，固定拓扑顺序；没有批次大小、第一父链模式、淡化合并或通用 reflog 浏览设置。 |
| `graph.*`、`enhancedAccessibility`、`date.*`、`markdown`、`customEmojiShortcodeMappings`、`fileEncoding`、`repository.useMailmap` | 轨道使用主题色，节点与文本提示辅助识别；变更状态有字母和符号。作者显示和日期可见性可调。日期按设备区域显示，文本差异使用 UTF-8。配色编辑、日期格式模板、邮箱映射、提交正文 Markdown 和 emoji 渲染未提供。 |
| `keyboardShortcut.*`、`contextMenuActionsVisibility`、`retainContextWhenHidden`、`openNewTabEditorGroup`、`openToTheRepoOfTheActiveTextEditorDocument` | 图内查找、行与父子导航支持键盘；详情按钮与右键菜单提供同一组动作。按知识库和比较对象复用标签。没有可编辑的快捷键映射、菜单项配置或目标编辑器组选择。 |
| `dialog.addTag.*`、`createBranch.*`、`deleteBranch.*`、`resetCurrentBranchToCommit.*`、`resetUncommittedChanges.*`、`stashUncommittedChanges.*`、`applyStash.*`、`popStash.*` | 在当次操作中选择目标、标签类型、reset 模式或是否包含未跟踪项。推送标签单独确认。从历史建分支默认留在原分支；应用 stash 会尝试恢复索引。没有通用的对话框默认值编辑器。 |
| `dialog.cherryPick.*`、`merge.*`、`pullBranch.*`、`rebase.*`、`general.referenceInputSpaceSubstitution` | 已实现摘取、撤销、分支合并／变基和提交前预览。摘取自动创建提交；暂缓提交、追加来源标记、自定义 squash 说明、启动交互式变基编辑器、自动替换引用名空格等上游参数未开放。 |
| `dialog.fetchIntoLocalBranch.*`、`fetchRemote.*`、`repository.fetchAndPrune`、`repository.fetchAndPruneTags`、`repository.showUncommittedChanges`、`showUntrackedFiles` | 定向获取和清理分开预览。未提交行可隐藏，显示时含未跟踪文件。没有自动删除本地标签、强制改写本地分支或只隐藏未跟踪文件的通用开关。 |
| `customPullRequestProviders`、`repository.commits.fetchAvatars`、`showSignatureStatus`、`repository.sign.*`、`integratedTerminalShell` | 内置三种托管平台的网页入口。自定义托管平台、联网头像、签名状态／签名操作、内置终端未接入。 |
| `maxDepthOfRepoSearch`、`repositoryDropdownOrder`、`showStatusBarItem`、`sourceCodeProviderIntegrationLocation`、`tabIconColourTheme` | 通过已登记知识库、侧栏和命令面板定位仓库，状态栏由本插件 Git 设置控制。VS Code 的工作区扫描、SCM 提供者位置和标签主题属于宿主差异。 |

上游的打开图、获取、打开文件、增删仓库入口分别对应本插件的历史、同步、文件菜单和知识库登记流程。直接打开当前笔记适用于可确认对应关系的 Markdown 文件。提交正文按纯文本显示，普通网址可选择复制。跨库汇总或结束审阅、90 天自动清理审阅和导出仓库配置目前均未提供。移动端保留原有简版历史。自动化覆盖的行为可按表中的测试入口复跑；桌面实测另核对主题、键盘操作、滚动位置和实际打开的比较对象。
