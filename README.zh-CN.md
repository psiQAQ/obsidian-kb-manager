# Knowledge Base Manager

[English](README.md)

> **Obsidian 桌面端多知识库管理插件（`knowledge-base-manager`）**：在同一个 Obsidian Vault 中，用「一库一 `kb.toml` + 一库一 Git」的方式创建、登记、模板化、体检并同步多个彼此独立的知识库。

本插件**不绑定任何特定 Vault 配置仓库**：无论你是全新建立一个空白 Obsidian Vault，还是在已有 Vault 中整理多个专题库，都可以独立安装并使用本插件。

---

## 目录

- [一、使用者指南（Users）](#一使用者指南users)
  - [1. 核心定位与特性](#1-核心定位与特性)
  - [2. 安装方式](#2-安装方式)
  - [3. 快速上手：从建库到同步](#3-快速上手从建库到同步)
  - [4. 内置 18 套知识库模板一览](#4-内置-18-套知识库模板一览)
  - [5. 知识库体检与离线 CLI（kb-check.cjs）](#5-知识库体检与离线-clikb-checkcjs)
  - [6. 常用命令与设置层次](#6-常用命令与设置层次)
- [二、开发者指南（Developers）](#二开发者指南developers)
  - [1. 仓库结构与详细注释](#1-仓库结构与详细注释)
  - [2. 核心架构与模块分层](#2-核心架构与模块分层)
  - [3. 构建流程与编译期注入](#3-构建流程与编译期注入)
  - [4. 开发、测试、打包与发布](#4-开发测试打包与发布)
  - [5. 扩展开发规范与安全边界](#5-扩展开发规范与安全边界)
- [三、许可与致谢](#三许可与致谢)

---

## 一、使用者指南（Users）

### 1. 核心定位与特性

在单 Vault 托管多个专题知识库时，传统单仓 Git 和全局模板容易导致提交历史混杂、路径冲突与附件错放。**Knowledge Base Manager** 将每个子目录声明为带有唯一身份清单（`kb.toml`）的独立知识库单元，提供四项核心能力：

1. **多库生命周期管理**：在侧边栏统一完成建库、从远端克隆入库、登记/接管已有目录、安全改名与跨父目录迁移（含中断恢复保护）、只读归档。
2. **模板建库与按库插入页面模板**：内置 **9 类用途共 18 套知识库骨架**，并支持制作和登记个人模板；在笔记中运行 **「插入本库页面模板」**，只从当前所属库的模板目录挑选并预览属性冲突。
3. **内置质量体检 + 离线 Agent CLI**：支持跨平台通用链接/结构检查及每套模板专属的 `.mjs` 专项校验；同步打包 `kb-check.cjs`，供本地 AI Agent 或命令行在不打开 Obsidian 的情况下运行校验。
4. **按库隔离的 Git 工作流**（基于 Obsidian Git 2.43.0 适配改造）：
   - 树形/列表变更视图、并排/统一 Diff、单文件与差异块（Hunk）暂存/重置；
   - 智能提交、修订提交（Amend）、推送前提交压缩预览（Squash）、拉取前 Fetch 预览与合并/变基策略；
   - 分支与远端管理、编辑器内冲突块就地解决、行级作者信息（Line Author / Blame）与状态栏实时变更计数；
   - 逐库独立授权的自动化提交/拉取/推送、Glob 忽略过滤及每库覆盖偏好。

---

### 2. 安装方式

> 当前版本 `3.1.0` 要求 Obsidian 桌面端 `1.15.1` 及以上（`isDesktopOnly: true`），桌面 Git 功能依赖本机已安装的系统 `git`（可在设置高级页指定可执行文件路径）。

#### 从 Obsidian 插件商店安装

在 **设置 → 第三方插件 → 浏览** 中搜索 **Knowledge Base Manager**，点击 **安装**，再点击 **启用**。也可在官方目录中点击 **Add to Obsidian** 打开插件详情。[商店条目](https://community.obsidian.md/plugins/knowledge-base-manager)

#### 从 GitHub Releases 手动安装

1. 打开目标版本的 **Assets**，分别下载 `main.js`、`manifest.json` 和 `styles.css`。[最新 Release](https://github.com/psiQAQ/obsidian-kb-manager/releases/latest)
2. 在 Vault 的插件目录中创建 `knowledge-base-manager` 文件夹，把三个文件直接放入其中。使用自定义 Vault 配置目录时，将下方的 `.obsidian` 替换为实际目录名。
   ```text
   <你的 Vault>/.obsidian/plugins/knowledge-base-manager/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```
3. 重启或重载 Obsidian，进入 **设置 → 第三方插件** 启用 **Knowledge Base Manager**。

如需制作离线安装包，可从源码构建并运行打包脚本，得到 `dist/knowledge-base-manager.zip`。[本地打包步骤](docs/development.md)

---

### 3. 快速上手：从建库到同步

1. **打开管理器**：点击左侧功能区书库图标（或运行命令 `打开知识库管理器`），在右侧栏打开管理器视图。
2. **新建或接管知识库**：
   - **新建**：点击 **新建**，先选用途与模板，再点 **填写知识库信息**。选择 Vault 根目录、常用位置或其他父目录，填写物理目录名，核对 Git 身份、初始分支和首提交说明。预览中可逐项取消模板建议的搜索排除目录。使用默认值时，创建后可在 `main` 看到 `Initial commit`。[建库示例](docs/getting-started.md)
   - **克隆**：使用 `克隆知识库` 向导将远端 Git 知识库拉取到选定父目录并核验清单。
   - **接管已有目录**：在 **管理 Vault 知识库登记** 中输入清单的相对路径、逐层浏览或扫描所选目录。若要查找其他目录中的清单，在扫描目录选择器中选择 **Vault 根目录** 并确认扫描。
3. **写笔记与插模板**：在目标库内打开笔记，调用命令 **`插入本库页面模板`**，插件会读取当前库的模板目录并高亮展示 Frontmatter 属性合并预览（已存在的同名属性保留原值）。
4. **查看状态与同步**：在右侧管理器展开对应知识库即可查看工作区改动、查看历史提交、执行拉取/推送或一键 **`提交并同步本库`**。

---

### 4. 内置 18 套知识库模板一览

插件在构建时内置以下 9 大场景、共 18 套开箱即用的知识库骨架（每套均包含示例页面、页面模板、视图及对应的专项体检脚本）：

| 用途分类 | 模板名称 | 模板 ID | 适用场景与默认专项检查 |
| --- | --- | --- | --- |
| `ai-workflows` | **AI 协作工作记忆** | `ai-worklog` | 工作卡、会话交接与决策页接续人机协作（检查决策取代关系） |
| `ai-workflows` | **融合 LLM Wiki** | `llm-wiki` | 保存资料原件，构建可追溯的知识页、索引与日志（知识页索引与分析证据） |
| `collections` | **Kepano（含示例）** | `kepano` | 按分类属性管理书影音、人物、地点与剪藏（分类链接完整性） |
| `collections` | **媒体体验记录** | `media-tracker` | 记录书影音进度、评分、感想与合集（媒体进度和评分） |
| `engineering` | **知识花园** | `knowledge-garden` | 将随手种子整理为可分享与持续更新的经验（拟分享条目的私有引用） |
| `engineering` | **技术雷达** | `technology-radar` | 用评估、试用、采用、暂缓记录选型依据（采用依据与状态） |
| `learning` | **课程学习** | `coursework` | 管理课程、讲义、作业与截止日期（有效课程和截止日） |
| `learning` | **专题备考与错题复做** | `exam-practice` | 按专题训练题型，记录错因与复做结果（掌握状态的复做记录） |
| `projects` | **行动清单与 GTD** | `gtd` | 从收件箱梳理下一步行动、等待与重复事项（等待事项跟进日期） |
| `projects` | **项目推进与周期复盘** | `project-review` | 项目正文推进任务，周复盘保留完成与归档记录（归档前未完成任务） |
| `reading` | **领域阅读与间隔复习** | `domain-reading` | 从领域入口安排阅读并将术语转为问答卡片（复习卡问答） |
| `reading` | **卡片盒** | `zettelkasten` | 闪念与文献批注提炼为永久卡与结构页（永久卡来由） |
| `research` | **研究证据图谱** | `research-evidence` | 用作者、来源、原子证据与主题页组织跨资料分析（证据来源类型） |
| `research` | **课题研究** | `research-project` | 关联研究问题、资料、研究日志与阶段结论（结论证据） |
| `starter` | **首周笔记** | `minimal-first-week` | 一页指引与每日一条记录快速熟悉双链（日记入口及日期） |
| `starter` | **日记与知识札记** | `minimal-journal` | 日记留存当天经过，札记按年归档并关联想法（札记归档年份） |
| `writing` | **长篇书稿** | `manuscript` | 一部书稿一个大纲，独立章节撰写与修订（书稿内章节序号） |
| `writing` | **世界观与时间线** | `worldbuilding` | 人物、地点、阵营与事件互链构建设定集（事件日期与地点） |

> 除了内置模板，你还可以在 **设置 → Knowledge Base Manager → 知识库目录与模板 → 制作模板** 中创建个人可实例化模板（详见 [docs/template-authoring.md](docs/template-authoring.md)）。

---

### 5. 知识库体检与离线 CLI（`kb-check.cjs`）

在知识库行的 **… → 检验** 中，插件会运行结构/链接检查以及该库模板声明的专项检查（`checks/*.mjs`）：
- **脚本安全校验**：内置模板的检验脚本使用发布包预置的 SHA-256 摘要；运行第三方或个人自制模板的脚本前，选择 **审查脚本**，核对源码与摘要后点 **信任此版本**。脚本在本机以当前账号权限运行，修改后需重新核对。
- **离线 CLI**：在 **… → 检验 → 导出离线检验工具** 中导出 `kb-check.cjs`，然后在导出文件所在目录用 Node.js 运行以下命令。工具输出单行 UTF-8 JSON，并在库内 `.log/` 留存检查历史。
  ```bash
  node kb-check.cjs --library "<Vault>/<库路径>" --vault-root "<Vault>" --list
  node kb-check.cjs --library "<Vault>/<库路径>" --vault-root "<Vault>" --checks all
  ```

---

**查看报告。** 选择 **查看报告 JSON**，选中所需文本后用系统的复制命令取用。设置中的 **调试信息 → 查看** 也提供只读 JSON。

**报告判读。** 单独勾选 **可移植性**，可检查库外依赖。桌面默认在本库和已登记库中查找同名候选，可勾选 **在整个 Vault 查找同名候选** 扩大范围。实际打开的目标始终由 Obsidian 按整个 Vault 解析。离线证据不足时会显示未验证。退出码 0 也可能对应部分完成；agent 应读取报告的 `status`、各项 `coverage` 和 `diagnostics`。[检验与 CLI 示例](docs/diagnostics.md)

### 6. 常用命令与设置层次

#### 核心命令（支持中/英跟随 Obsidian 或插件内语言设置）
- **管理与模板**：`打开知识库管理器`、`新建知识库`、`克隆知识库`、`管理 Vault 知识库登记`、`插入本库页面模板`
- **版本与提交**：`保存本库版本`、`查看本库历史`、`提交并同步本库`、`同步后关闭当前笔记`、`本库 Git 状态`
- **单文件与编辑器**：`暂存当前文件`、`取消暂存当前文件`、`查看当前文件差异`、`查看当前行作者`、`编辑本库忽略规则`、`在本库忽略当前文件`、`在 GitHub 查看当前文件`、`在 GitHub 查看当前文件历史`
- **网络操作**：`获取本库远端`、`拉取本库`、`推送本库`、`管理本库分支`、`设置本库远端`、`管理本库自动操作`

#### 设置存储在哪里？
- **插件数据**（默认位于 `.obsidian/plugins/knowledge-base-manager/data.json`）保存语言偏好、全局 Git 默认值和已登记知识库的 Vault 相对路径。公开 Vault 配置前，请检查该文件是否已被 Git 跟踪。[登记与恢复](docs/library-lifecycle.md)
- **本机设备状态**（Obsidian `localStorage`）：保存本设备的父目录、个人模板登记、自动化授权与中断恢复记录，不跨设备误同步。
- **单库身份与覆盖配置**（`<库根目录>/kb.toml`）：保存库 UUID、模板信息、目录映射 `[paths]`、受管文件指纹及该库对全局 Git 偏好的覆盖项；Git 账号身份与远端配置存于该库 `.git/config`，备用 HTTPS 凭据存于 Obsidian `SecretStorage`。

---

**网络、凭据与本机访问。** 本地建库和检验可离线使用。克隆、获取、拉取、推送会访问你配置的 Git 远端；推送会发送待推的提交及其历史。后台同步须按库授权。桌面从 Vault 外选择 Git 和 OpenSSH 可执行文件，以独立参数启动程序，并使用系统 Git 配置、凭据助手或 SSH 代理，也可为指定 HTTPS 目标选用 SecretStorage 中的令牌。模板专项会查找 Vault 外的 Node.js 可执行文件，并将所需笔记上下文交给已授信的脚本；该进程具有当前账号的文件和网络权限。[逐库 Git 与凭据](docs/library-git.md) · [迁移、恢复与设置存储](docs/library-lifecycle.md)

## 二、开发者指南（Developers）

### 1. 仓库结构与详细注释

```text
obsidian-kb-manager/
├── manifest.json                    # Obsidian 插件清单（id: knowledge-base-manager，isDesktopOnly: true）
├── versions.json                    # 插件版本 -> 最低兼容 Obsidian 版本映射表
├── package.json                     # npm 脚本、运行时依赖（isomorphic-git/smol-toml/yaml/diff/picomatch）与工具链
├── tsconfig.json                    # TypeScript 严格模式配置（允许 .ts 扩展名导入）
├── esbuild.config.mjs               # 双产物构建配置：插件 main.js + 独立诊断 CLI dist/kb-check.cjs
├── eslint.config.mts                # ESLint + eslint-plugin-obsidianmd 规则配置
├── styles.css                       # 插件 UI 样式
├── version-bump.mjs                 # 版本号同步脚本（更新 manifest.json 与 versions.json）
├── LICENSE                          # 0-BSD 开源许可
├── AGENTS.md                        # 本插件仓库开发规范与 Obsidian 社区插件约束
│
├── src/                             # 插件 TypeScript / Svelte 源码
│   ├── main.ts                      # 桌面端插件入口：生命周期、Vault 互斥锁、命令与视图注册
│   ├── settings.ts                  # 分页设置界面（全局默认值与单库覆盖编辑）
│   ├── preferences.ts               # 全局/单库 Git 偏好解析、默认值合并与提交模板渲染
│   ├── i18n.ts                      # 简体中文 / English 双语切换工具
│   │
│   ├── kb/                          # 知识库领域核心层（无 UI 耦合）
│   │   ├── catalog.ts               # 扫描发现、状态检查、重复 ID 标定与并发签名校验 recheck()
│   │   ├── identity-core.ts         # kb.toml 解析与序列化、ManagedFile 受管文件指纹管理
│   │   ├── mapping.ts               # [paths] 目录映射解析与路径重叠/合法性校验
│   │   ├── create.ts / clone.ts / move.ts  # 建库、克隆发布与可恢复跨目录移动
│   │   ├── insert.ts / template*.ts # 页面模板检索、{{kb_name}}/{{kb_root}} 实例化与模板打包读取
│   │   ├── audit*.ts / maintenance.ts / kepano.ts  # 跨平台结构/链接审计、修复与 Kepano 专项支持
│   │   ├── manifest-disk.ts / manifest-upgrade.ts / upgrade-checks.ts  # 清单磁盘并发保护与版本升级
│   │   ├── bindings.ts / instance-text.ts / preference-migration.ts / sources.ts / toml-edit.ts
│   │
│   ├── git/                         # 按库隔离的 Git 服务层（支持系统原生 Git 与 isomorphic-git）
│   │   ├── repository.ts            # 仓库状态抽象与后端调度
│   │   ├── network-native.ts        # 桌面系统 Git 调用封装（含 blameLine、合并、变基等）
│   │   ├── network-http.ts / network-merge.ts / network-refs.ts / network-automation.ts / network-config.ts / network.ts
│   │   ├── index-actions.ts / index-conflicts.ts / index-history.ts / index-transaction.ts  # 索引、冲突与历史
│   │   ├── authorship.ts / hunk-lines.ts    # 行作者解析与差异块行号定位
│   │   ├── versions.ts / squash.ts / initial.ts / identity.ts / guard.ts
│   │   ├── markdown-attributes.ts / manifest-privacy.ts / settings-migration.ts
│   │
│   ├── diagnostics/                 # 知识库体检引擎与离线 CLI
│   │   ├── cli.ts                   # 独立入口：编译为 dist/kb-check.cjs 供终端 / AI Agent 调用
│   │   ├── index.ts                 # 体检调度入口（通用检查 + 专项脚本执行 + JSON 报告生成）
│   │   ├── special.ts / snapshot.ts # 专项脚本 .mjs 的 SHA-256 摘要校验、上下文传递（notes/links）与执行
│   │   ├── check-links.ts / links.ts / references.ts / structures.ts / base-view.ts / fences.ts / coverage.ts / history.ts / types.ts
│   │
│   ├── fs/                          # Vault 文件系统安全边界
│   │   ├── vault.ts / paths.ts / segments.ts / publish.ts  # 路径越界防御、原子写入与发布预览
│   │
│   ├── registry/                    # 插件 data.json 中的知识库登记
│   │   ├── desktop.ts / discovery.ts / import.ts / paths.ts
│   │
│   ├── ui/                          # 桌面端 Obsidian UI、Modal 向导与编辑器集成
│   │   ├── manager.ts               # 右侧栏 Knowledge Base Manager 主视图
│   │   ├── source.ts / source-diff.ts / source-editor.ts / source-history.ts / source-conflicts.ts
│   │   ├── source-components/FileRow.svelte   # Svelte 5 变更文件行组件
│   │   ├── library-commands.ts / file-commands.ts / insert-template.ts / template-picker.ts
│   │   ├── create.ts / clone.ts / sync.ts / maintain.ts / authorship.ts / versions.ts
│   │   ├── v3-health.ts / v3-template-catalog.ts / v3-template-author.ts  # v3 体检、模板市场与向导
│   │   ├── device.ts / dialog.ts / git-path.ts / identity.ts / library-status.ts / manager-registry.ts / network*.ts / refresh.ts / registry-ignore.ts / repository-identity.ts / text-field.ts
│   │
│   └── mobile/                      # 移动端轻量化兼容实现（当前 manifest 仍为桌面独占，构建入口按 Platform.isMobile 分流）
│       └── plugin.ts / view.ts / git.ts / http.ts / catalog.ts / bindings.ts / forms.ts / ...
│
├── assets/                          # 随插件打包的静态资源与内置模板
│   ├── licenses/obsidian-git.txt    # 上游 Obsidian Git 许可文本（注入 main.js banner 与离线 ZIP）
│   └── templates/<purpose>/<id>/    # 9 类用途共 18 套内置模板（含 kb-template.json、checks/*.mjs、LICENSES.md）
│
├── scripts/                         # 构建、校验与发布脚本
│   ├── template-catalog.mjs         # 构建期读取 assets/templates/，生成 KB_TEMPLATE_PACKS 与校验摘要 KB_CHECK_DIGESTS
│   ├── package_plugin.py            # 审计依赖白名单与许可，生成 dist/knowledge-base-manager.zip
│   └── verify-mobile.mjs            # 校验移动端入口捆绑不引入 Node/Electron 独占模块
│
├── tests/                           # Node 原生 test runner 测试套件（27 个 *.test.mjs + fixtures/）
├── docs/                            # 公开技术文档（template-catalog.md / template-authoring.md / git-compatibility.md）
├── references/                      # [Git Submodules] 上游对照源码（obsidian-git、kepano-obsidian、15 套模板上游等），严禁打入发行包
└── .github/workflows/               # CI（Windows/macOS/Ubuntu 三平台校验）与 Tag Draft Release 发布流
```

---

### 2. 核心架构与模块分层

1. **严格单库边界与并发安全**：
   - 建库提交和写入逐库偏好等操作按知识库路径串行执行。写入偏好前通过 `recheck(disk, config, lib)` 校验 `kb.toml` 内容摘要 `signature`，防止列表过期或身份重复导致误写。
   - 跨目录移动通过 `recordMove()` 记录阶段状态，中断后可恢复。
2. **双构建目标（Plugin + Standalone CLI）**：
   - `esbuild.config.mjs` 同时产出 Obsidian 插件 `main.js`（CommonJS，含 `esbuild-svelte` CSS 注入及 `isomorphic-git` 的 `buffer/` 垫片）和独立的 Node 20 命令行工具 `dist/kb-check.cjs`（`src/diagnostics/cli.ts`），保证桌面界面与离线 Agent 共享同一套体检判定逻辑。
3. **双端入口分流与边界验证**：
   - 打包入口通过 `require('obsidian').Platform.isMobile` 分流至 `src/main.ts` 或 `src/mobile/plugin.ts`，CI 通过 `scripts/verify-mobile.mjs` 保证移动端分支与依赖边界不被破坏（尽管当前发布清单 `manifest.json` 保守标记 `isDesktopOnly: true`）。

---

### 3. 构建流程与编译期注入

运行 `npm run build` 时，构建管线会依次完成：
1. 执行 `tsc -noEmit -skipLibCheck` 做全量 TypeScript 类型检查。
2. 调用 `scripts/template-catalog.mjs` 遍历 `assets/templates/*/*/kb-template.json`，将全部 18 套模板资源与 `checks/*.mjs` 的 SHA-256 摘要序列化为编译期常量 `KB_TEMPLATE_PACKS` 与 `KB_CHECK_DIGESTS`。
3. 生成 `main.js`、`dist/kb-check.cjs` 以及元信息 `dist/build-inputs.json`、`dist/cli-build-inputs.json` 供后续打包审计使用。

---

### 4. 开发、测试、打包与发布

#### 环境要求
- Node.js 24（与 CI 一致），以及系统 Git
- Python 3（运行 `scripts/package_plugin.py` 生成离线安装 ZIP）

完整构建、许可打包与平台验证说明见[开发指南](docs/development.md)。

#### 常用开发命令
```bash
npm install                   # 安装依赖
npm run dev                   # esbuild 监听模式（输出含 inline sourcemap 的 main.js）
npm run typecheck             # TypeScript 严格检查 (tsc --noEmit)
npm run lint                  # ESLint + eslint-plugin-obsidianmd 规则检查
npm test                      # 运行 tests/*.test.mjs 全部自动化测试
npm run build                 # 生产构建 main.js 与 dist/kb-check.cjs
node scripts/verify-mobile.mjs # 校验移动端打包边界
python scripts/package_plugin.py # 生成并核验 dist/knowledge-base-manager.zip
```

#### 本地部署到 Obsidian 测试
将仓库根目录构建出的 `main.js`、`manifest.json` 与 `styles.css` 复制到测试 Vault 的 `.obsidian/plugins/knowledge-base-manager/` 目录，并在 Obsidian 中重新加载插件即可。

#### CI 与版本发布
- **每次 Push / PR**：`.github/workflows/lint.yml` 在 `windows-latest`、`macos-latest`、`ubuntu-latest` 三平台运行 `typecheck`、`lint`、`test`、`build`、`verify-mobile.mjs` 与 `package_plugin.py`。
- **Tag 发布**：使用 `npm run version` 同步更新 `manifest.json` 与 `versions.json`，推送不带 `v` 前缀的语义化版本 Tag（如 `3.1.0`）后，发布工作流会构建插件、生成构建证明并创建草稿 Release。上传的附件为 `main.js`、`manifest.json` 和 `styles.css`。

---

### 5. 扩展开发规范与安全边界

- **依赖与许可审计**：`scripts/package_plugin.py` 会核对 `dist/build-inputs.json` 中的全部外部 `imports` 是否位于安全白名单内，并确保 `references/` 子模块代码**绝不**被打包进最终产物，同时自动收集所有第三方 npm 包与内置模板的许可文本写入包内 `THIRD_PARTY_NOTICES.md`。
- **模板与体检安全原则**：
  - 模板中的 `checks/*.mjs` 运行在独立 Node 进程中，作者须遵守只读约定；且模板声明不得自授信，仅当脚本摘要匹配内置官方摘要或获得用户显式信任后方可执行。
  - 新增内置模板需遵循 [docs/template-authoring.md](docs/template-authoring.md) 的目录规范与上游来源标注要求。
- **Git 兼容与隔离边界**：禁止跨出已登记知识库的 `.git` 边界执行递归子模块操作或任意 shell 命令；所有上游 Obsidian Git 的功能映射状态与边界说明见 [docs/git-compatibility.md](docs/git-compatibility.md)。

---

## 三、许可与致谢

- 本插件本体采用 [0-BSD License](LICENSE) 开源。
- 知识库 Git 管理部分代码改编自 [Obsidian Git 2.43.0](https://github.com/Vinzent03/obsidian-git)（MIT License，许可原文见 [assets/licenses/obsidian-git.txt](assets/licenses/obsidian-git.txt)）。
- 内置 18 套知识库模板分别源自多位社区作者的开源作品并保留各自上游许可与署名，完整清单请参阅 [docs/template-catalog.md](docs/template-catalog.md) 及各模板目录下的 `LICENSES.md`。
