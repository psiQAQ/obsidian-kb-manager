# Knowledge Base Manager

在同一个 Obsidian Vault 里，把研究课题、读书笔记和个人收藏分别建成知识库。每个新库有自己的模板、身份清单 `kb.toml` 和 Git 历史。在侧栏选中哪个库，就能查看那个库的改动、提交版本或运行检验。空白 Vault 和已有 Vault 均可使用，直接安装插件即可。

[离线安装](#离线安装) · [创建第一个库](#创建和保存第一个版本) · [18 套模板](#内置模板) · [知识库检验](#知识库检验) · [开发者指南](#开发者指南)

## 使用者指南

### 离线安装

本仓库版本为 **3.0.2**，适用于 Obsidian 桌面版 **1.15.1 或更高版本**。建库和桌面 Git 操作需要系统 Git。模板专项检验和离线 CLI 还需要本机 Node.js，使用 Node.js 24 可与项目验证环境一致。

1. 在 [GitHub Releases](https://github.com/psiQAQ/obsidian-kb-manager/releases) 查看已公开的版本及附件。若所需版本没有列出 `knowledge-base-manager.zip`，可从对应版本源码[构建离线包](docs/development.md#本地验证)。
2. 将整个 ZIP 解压到目标 Vault 的 `.obsidian/plugins/`。若自定义了 Vault 配置目录，使用该目录下的 `plugins/`。解压后的目录应为：

   ```text
   plugins/knowledge-base-manager/
   ├── manifest.json
   ├── main.js
   ├── styles.css
   ├── kb-check.cjs
   ├── LICENSE
   └── THIRD_PARTY_NOTICES.md
   ```

3. 重新加载 Obsidian，在 **设置 → 第三方插件** 启用 **Knowledge Base Manager**。点左侧书架图标，或在命令面板运行 **打开知识库管理器**，即可在右侧栏看到管理器。

### 创建和保存第一个版本

1. 在管理器点 **新建**，选择 **AI 协作 → 融合 LLM Wiki → 填写知识库信息**。
2. 保留默认父目录 `knowledge-base`，在 **物理目录名** 填「光学研究」。显示名可沿用目录名，简介可选。核对 Git 姓名和邮箱；只在本地工作时，`origin` 留空。
3. 点 **预览**，核对目标 `knowledge-base/光学研究`、提交身份和文件清单，再点 **创建**。打开本库历史，看到 `main` 分支上的 `Initial commit`，就已保存第一个本地版本。[建库示例与 Git 身份回退规则](docs/getting-started.md)
4. 在该库的 `Notes/` 新建笔记，运行 **插入本库页面模板**，预览属性与正文后确认插入。已有同名属性保留原值。写完后从该库行打开 **Git 状态**，核对差异并提交。有远端时，再为这个库设置上游并同步。[逐库 Git 与部分暂存](docs/library-git.md)

已有远端仓库可通过 **克隆知识库** 导入。整库迁移时请一并携带 `kb.toml`，在 **管理 Vault 知识库登记** 中选择清单并预览导入。找回登记、给独立副本分配新身份、移动中断后的恢复都有独立的确认步骤。[接管、移动与修复](docs/library-lifecycle.md)

### 内置模板

先选用途，再挑模板。以下 9 类共 18 套均随插件打包。表中最后一列给出适用情形和默认专项，模板详情页会列出工作流所需的社区插件。[上游来源、作者与许可](docs/template-catalog.md)

| 用途分类 | 模板名称 | 模板 ID | 适用场景与默认专项检查 |
| --- | --- | --- | --- |
| `ai-workflows` | **AI 协作工作记忆** | `ai-worklog` | 工作卡、会话交接与决策页接续人机协作（决策取代关系） |
| `ai-workflows` | **融合 LLM Wiki** | `llm-wiki` | 保存资料原件，构建可追溯的知识页、索引与日志（知识页索引与分析证据） |
| `collections` | **Kepano（含示例）** | `kepano` | 按分类属性管理书影音、人物、地点与剪藏（分类链接） |
| `collections` | **媒体体验记录** | `media-tracker` | 记录书影音进度、评分、感想与合集（媒体进度和评分） |
| `engineering` | **知识花园** | `knowledge-garden` | 将随手种子整理为可分享与持续更新的经验（拟分享条目的私有引用） |
| `engineering` | **技术雷达** | `technology-radar` | 用评估、试用、采用、暂缓记录选型依据（采用依据与状态） |
| `learning` | **课程学习** | `coursework` | 管理课程、讲义、作业与截止日期（有效课程和截止日） |
| `learning` | **专题备考与错题复做** | `exam-practice` | 按专题训练题型，记录错因与复做结果（掌握状态的复做记录） |
| `projects` | **行动清单与 GTD** | `gtd` | 从收件箱梳理下一步行动、等待与重复事项（等待事项跟进日期） |
| `projects` | **项目推进与周期复盘** | `project-review` | 项目正文推进任务，周复盘保留完成与归档记录（归档前的未完成任务） |
| `reading` | **领域阅读与间隔复习** | `domain-reading` | 从领域入口安排阅读并将术语转为问答卡片（复习卡问答） |
| `reading` | **卡片盒** | `zettelkasten` | 闪念与文献批注提炼为永久卡与结构页（永久卡来由） |
| `research` | **研究证据图谱** | `research-evidence` | 用作者、来源、原子证据与主题页组织跨资料分析（证据来源类型） |
| `research` | **课题研究** | `research-project` | 关联研究问题、资料、研究日志与阶段结论（结论证据） |
| `starter` | **首周笔记** | `minimal-first-week` | 一页指引与每日一条记录快速熟悉双链（日记入口与日期） |
| `starter` | **日记与知识札记** | `minimal-journal` | 日记留存当天经过，札记按年归档并关联想法（札记归档年份） |
| `writing` | **长篇书稿** | `manuscript` | 一部书稿一个大纲，独立章节撰写与修订（书稿内章节序号） |
| `writing` | **世界观与时间线** | `worldbuilding` | 人物、地点、阵营与事件互链构建设定集（事件日期与地点） |

想复用自己的目录时，可在 **设置 → Knowledge Base Manager → 知识库目录与模板** 登记目录模板，也可在 **制作模板** 一栏点 **打开向导**，声明入口、建库变量、页面模板和专项脚本。登记后，在建库向导的 **我的模板** 中选择它。[从普通目录制作可实例化模板](docs/template-authoring.md)

### 知识库检验

首次检验时，在侧栏找到刚创建的库（例如「光学研究」），打开 **… → 检验**。**运行全部适用项** 会检查清单、笔记属性、链接与嵌入、标题与块、Canvas、Bases、受管绑定，以及本库声明的专项。要判断把库单独搬走会丢失哪些依赖，勾选 **可移植性**，点 **运行所选**。

例如，A、B 两个库都有 `实验记录.md`。桌面检验使用 Obsidian 在来源页实际选中的目标，可移植性报告能列出同名候选与实际路径。离线 CLI 缺少这项解析证据时会标为未验证。阅读报告时，同时看问题的严重程度和检查的覆盖情况。

专项脚本在独立的 Node.js 进程中以当前系统账号权限运行，只读是模板作者应遵守的约定。官方脚本按发行包内的 SHA-256 摘要识别；个人脚本在 **审查脚本** 中核对源码和摘要后，可选择 **信任此版本**。修改脚本后需要重新核对。

离线 agent 可在解压后的插件目录执行以下命令，将两个路径替换为实际位置：

```sh
node kb-check.cjs --library "/path/to/Vault/knowledge-base/光学研究" --vault-root "/path/to/Vault" --checks all
```

命令将 JSON 报告写到标准输出，新库默认在 Git 忽略的 `.log/` 中保存检验历史。退出码为 0 时也可能部分完成；agent 应读取顶层 `status`，逐项检查 `checks[].coverage` 和 `checks[].diagnostics`。[CLI 示例、状态与退出码](docs/diagnostics.md#离线运行与读取报告)

### 常用命令与设置

| 想做的事 | 入口 |
|---|---|
| 从当前笔记提交或查看历史 | **保存本库版本**、**查看本库历史**。不能从笔记确定目标时会打开选库器。 |
| 核对文件差异、暂存范围和提交署名 | 当前库的 **Git 状态**。已暂存版本与工作区修改可分别查看。 |
| 手动同步或授权自动操作 | **提交并同步本库**、**管理本库分支**、**管理本库自动操作**。自动提交、拉取和推送按库授权。 |
| 给某个库设置例外 | **… → 本库 Git 设置** 覆盖全局默认值；Git 身份与远端由本库 Git 配置管理。 |

全局语言和 Git 默认值保存在插件的 `data.json`。登记表保存 Vault 相对路径，库身份和逐库偏好随 `kb.toml` 保存在本地，自动化授权则留在本设备。[文件与设置存放位置](docs/library-lifecycle.md#文件和设置存放位置) · [与 Obsidian Git 的功能对照](docs/git-compatibility.md)

## 开发者指南

<details>
<summary>展开带注释的源码目录树</summary>

```text
obsidian-kb-manager/
├── manifest.json、versions.json     插件版本、平台和最低 Obsidian 版本
├── package.json、package-lock.json  npm 脚本与依赖
├── esbuild.config.mjs              插件和离线 CLI 的构建入口
├── styles.css                      插件界面样式
├── src/
│   ├── main.ts、settings.ts         桌面生命周期、命令注册和设置界面
│   ├── kb/                         实例身份、建库、模板、移动与维护
│   ├── registry/                   Vault 登记表、发现与导入
│   ├── fs/                         路径校验与文件系统操作
│   ├── diagnostics/                检验引擎、脚本执行、报告与 CLI
│   ├── git/                        本库提交、差异、历史、远端与同步
│   ├── ui/                         桌面侧栏、建库向导、检验与编辑器界面
│   └── mobile/                     移动端兼容入口
├── assets/
│   ├── templates/<purpose>/<id>/   模板文件、声明、专项脚本与来源许可
│   └── licenses/                   随包代码的上游许可材料
├── scripts/                        模板目录生成、移动入口验证与 ZIP 打包
├── tests/                          Node.js 回归测试与样例
├── docs/                           使用、模板制作和技术文档
├── references/                     供开发者对照的上游子模块
└── .github/workflows/              三平台验证及草稿 Release 工作流
```

</details>

**写入与恢复。** 桌面管理器按库路径串行执行建库提交、写入逐库偏好等操作。写偏好前会重新发现该库，核对身份唯一性和清单摘要；移动另外记录源、目标和执行阶段，中断后可以复核并继续。[桌面入口](src/main.ts) · [身份复核](src/kb/catalog.ts) · [移动恢复](src/kb/move.ts)

**构建与验证。** 开发环境使用 Node.js 24、npm、系统 Git 和 Python 3。构建从模板目录生成 `KB_TEMPLATE_PACKS` 与 `KB_CHECK_DIGESTS`，输出 Obsidian 加载的 `main.js` 和独立的 `dist/kb-check.cjs`。生产包还包含移动端兼容入口，当前发行清单仅开放桌面安装。[构建命令、打包与平台验证](docs/development.md)

## 许可与致谢

插件本体采用 [0-BSD 许可](LICENSE)。逐库 Git 工作流参考并适配了 Obsidian Git 2.43.0 的功能，保留了 [Obsidian Git 的 MIT 许可](assets/licenses/obsidian-git.txt)。模板各自的上游作者、引用范围和许可见[模板目录](docs/template-catalog.md)；离线包中的 `THIRD_PARTY_NOTICES.md` 汇集了模板和随包代码的许可材料。
