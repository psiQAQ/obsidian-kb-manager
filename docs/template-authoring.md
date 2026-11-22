# 制作可实例化的知识库模板

在桌面的 **设置 → Knowledge Base Manager → 知识库目录与模板** 找到 **制作模板**，点 **打开向导**，填入 Vault 内尚不存在的目录、模板 ID、名称和用途。勾选专项示例，预检后建立目录、登记模板并试建。也可以先编辑目录，再在设置中登记。个人模板在 **新建知识库 → 我的模板** 以及所声明的用途下可见。没有清单的旧目录模板也可以登记和复制。

## 从普通目录做模板

在 Vault 中建立一个普通文件夹，例如 `样板/项目资料夹`，在设置中把它登记为目录模板。新建向导中选择它。普通模板逐字节复制，保留空目录、图片和 PDF。预览列出排除的隐藏文件、Git 历史和环境目录。请把模板目录和实际创建的知识库分开放置。

要指定首页和需要渲染的文本，在模板根目录添加 `kb-template.json`。例如，以下声明只替换 `首页.md` 中的 `{{kb_name}}` 和 `{{description}}`。

```json
{
  "id": "research-folder",
  "version": "1",
  "entry": "首页.md",
  "text": { "首页.md": ["kb_name", "description"] }
}
```

目录模板沿用内置 `knowledge.base` 的六处总览绑定时，可声明 `"managed": ["knowledge.base:overview-bindings"]`。移动时只修改已匹配的过滤条件，自定义表达式保留供人工检查。

另一个可用变量为 `kb_root`，表示最终 Vault 相对目录。可用 `hidden` 数组声明允许复制的隐藏文件相对路径。未声明的 `{{date:YYYY-MM-DD}}` 等笔记模板变量原样保留。目录模板不指定入口时，**打开** 会列出本库可打开的 Markdown 笔记。

## 声明协议与双实例验收

编辑器可以将 `kb-template.json` 关联到仓库的 [JSON Schema](schemas/kb-template.schema.json)。在支持 JSON Schema 的编辑器中选择本地文件，或填写指向本地副本的 `$schema`。模板协议用 `protocolVersion` 表示，模板自身的发布编号仍使用 `version`。旧声明可以省略协议版本。发布需要指定管理器最低版本时使用 `minManagerVersion`，填写已经实际验证的三段式版本号。

[阅读手记样例](examples/protocol-template/kb-template.json)包含一个可选的 Templater 工作流和一个允许由模板升级的读书卡。将整个 `examples/protocol-template` 复制到测试 Vault 的 `样板/阅读手记`，登记为目录模板，再验证以下结果。

1. 用同一模板分别创建 `书架/甲` 和 `书架/乙`，从两个首页点击“读书卡模板”。查看实际打开的文件路径，应分别位于各自的 `Templates` 目录。
2. 在甲库另建一篇读书笔记，在乙库的 `Templates/读书卡.md` 尾部加一行批注。将模板源的 `version` 改为 `2`，并在模板源的读书卡中添加“## 引文”。
3. 分别打开两库的模板更新预览。甲库的读书卡可以应用“引文”变动，新建的笔记继续保留。乙库的读书卡应标为冲突，保留批注。对比每个库的工作区差异。

`dependencies` 中的字符串仍表示可选社区插件。对象形式可声明 `id`、`required` 和 `minVersion`。使用 `managedFiles` 列出需要升级的 UTF-8 文本，每个文件最多 1 MiB。供用户长期写作的文件应留在列表之外。旧版声明的总览绑定继续通过 `managed` 管理。

创建知识库时，管理器把受管文件的指纹写入本库 `kb.toml` 的 `[templateFiles]`。桌面在库行选择 **… → 更新受管模板文件**，从本机已登记、ID 匹配的模板目录选择新版本。在 **预览更新** 中展开文件，可对照本库内容和拟写入内容。遇到冲突时，右侧标为 **模板候选内容**，应用更新会保留本库的修改。应用时只替换与已记录指纹一致的文件，并添加目标库中未占用的新增路径。手动删除的文件、已有未登记文件和新版撤出管理的文件都由用户决定如何处理。较早创建的实例如果没有受管文件指纹，需人工核对和迁移。

若一部分文件有冲突，可以先应用其余安全项。管理器逐个记录已经应用的文件，旧版本号会保留到其余目标文件都可确认。应用新版撤出管理的项目会保留文件并取消登记。以后重新声明这个路径时，现存文件会标为冲突。人工合并后如内容与模板版本相同，再次预览可以确认仍在管理中的文件。模板实例仍保留创建时模板版本，供原有的专项检验使用。

## 一套课题模板

在 `样板/实验课题` 建立下面五个文件。首页、笔记、页面模板和脚本都使用 UTF-8。

| 文件 | 用途 |
|---|---|
| `kb-template.json` | 模板的公开协议，随实例纳入首提交 |
| `首页.md` | 实际打开的入口 |
| `课题/声学测量.md` | 一个可运行检验的实例样本 |
| `页面模板/课题.md` | 用户写新笔记时插入 |
| `checks/project-result.mjs` | 供桌面和离线 agent 使用的专项 |

`kb-template.json` 的内容如下。

```json
{
  "id": "experiment-project",
  "version": "1",
  "name": "实验课题",
  "description": "记录课题状态、结题成果和实验笔记。",
  "purpose": "research",
  "purposes": ["learning"],
  "entry": "首页.md",
  "pageTemplates": ["页面模板"],
  "suggestedExcludedFolders": ["页面模板"],
  "text": {
    "首页.md": ["kb_name", "description"]
  },
  "checks": [{
    "id": "project-result",
    "name": "结题成果",
    "description": "检查已结题的实验是否填写成果。",
    "path": "checks/project-result.mjs"
  }]
}
```

`suggestedExcludedFolders` 是模板作者给 Obsidian 搜索与图谱的建议，每项是实例内实际存在的相对目录。可包括页面模板和辅助目录，例如用于保存生成器的 `Integrations`。字段缺省时没有建议。建库人可逐项取消；选中的目录写入实例 `kb.toml` 的 `[manager].excludedFolders`，目录内容仍会复制，Git 与知识库检验各自沿用原有规则。

首页可以写成下面这样。

```markdown
# {{kb_name}}

{{description}}

进行中的课题见 [[./课题/声学测量|声学测量]]。
```

库内笔记和附件的位置固定时，从引用它的文件写相对路径。例如首页可以嵌入 `![[./Views/Courses.base]]`，子目录里的作业可以引用 `[[../课程索引]]`。普通链接检验会解析这些目标，整库搬走时相对关系仍成立。用于插入其他笔记的页面模板须按插入后的笔记位置考虑链接；若这个位置无法预知，可以声明 `kb_root`。

Base 的 `file.path` 是文件相对 Vault 根目录的路径。要筛出当前知识库中的文件，可以写 `file.path.startsWith("{{kb_root}}/")`，并在模板清单中声明替换这个变量。如果写成 `file.path.startsWith("../")`，表达式会筛选路径文字以两个点和一个斜杠开头的文件，课程视图就可能显示为空。

用显示名「声学实验」、简介「记录测量过程」创建到 `研究/实验甲`，即可在首页看到这两个值。链接将打开 `研究/实验甲/课题/声学测量.md`。在同一 Vault 再建「实验乙」，第二个实例的链接指向 `研究/实验乙`。将 `页面模板/课题.md` 写为含 `{{title}}` 和 `{{date:YYYY-MM-DD}}` 的普通页面模板，两处标记会保留到插入笔记时。

给 `课题/声学测量.md` 加入以下属性。

```yaml
---
type: experiment
status: completed
result: ""
---
```

`checks/project-result.mjs` 导出一个函数。可同步返回数组，也可异步返回。示例脚本只检查明确声明为实验并已结题的笔记。

```javascript
export default function check({ notes }) {
  return notes
    .filter(({ properties: p }) =>
      p.type === "experiment" && p.status === "completed" &&
      (typeof p.result !== "string" || !p.result.trim()))
    .map(({ path }) => ({
      severity: "error",
      code: "experiment.result-missing",
      file: path,
      message: "已结题的实验缺少成果。请根据实验记录填写 result。",
      evidence: "type=experiment, status=completed"
    }));
}
```

从库的 **… → 检验** 运行「结题成果」。首次运行个人脚本时核对文件与摘要，并决定是否信任。预期出现一条可定位到「声学测量」的错误。在该页把 `result` 改为实际成果并重新检验，错误应消失。再次编辑检查脚本后，需要核对变更后的摘要。内置校验脚本使用发布包提供的摘要；下载项目、打开笔记或创建实例都不会触发专项执行。

## 声明与实例的分工

- 模板 ID 在迭代间保持稳定，使用小写英文、数字和连字符。修改适配逻辑或模板内容时更新版本。主用途决定资源物理位置，其他用途只增加入口。用于分发的包必须有 `id`、`version`、`name`、`description`、`purpose`、`entry` 和 `sources`。
- `pageTemplates` 可声明多个相对目录。`text` 将具体文件映射到允许替换的建库变量。目前支持显示名 `kb_name`、简介 `description` 和 Vault 相对路径 `kb_root`。选择文本变量时应考虑文件语法。用户输入的名称、简介适合正文；把根路径用于实例内链接、Base 的目录约束和双引号中的固定路径。附件按原始字节复制。
- 可选的 `paths` 是模板作者声明的库内相对路径。例如 `"paths": {"experiments": "课题", "outcomes": "成果"}`。建库时插件把这些值写入实例的 `[paths]`，专项可读 `manifest.paths.experiments`。内置融合模板用这些声明保留旧布局的目录映射。
- `kb.toml` 随实例保存在本机，含独立 UUID、模板 ID 与版本、显示名、简介、可选入口、Git 偏好及受管字段。插件记录 `kb_root` 在声明文件中的实例化位置及文件指纹。通过插件改名或移动时预览这些字段。已编辑的受管文件列入人工复核。复制完整库可携带原清单恢复身份，新建独立副本使用新 UUID。
- 可选的 `variables` 提供专项默认值，例如在模板声明写 `"variables": {"minimumSources": 2}`。用户可在实例 `kb.toml` 写 `[variables]` 表并设 `minimumSources = 3`。脚本里用 `manifest.variables?.minimumSources ?? template.variables?.minimumSources ?? 2` 取值。支持字符串、有限数字和布尔值；阈值只参与检验，不会被替换进笔记。
- `checks` 可省略。每一项有库内唯一 ID、显示名、可选说明和位于 `checks/` 下的独立 `.mjs` 文件。使用输入中的 `template`、`manifest`、`libraryRoot`、`notes` 获取模板声明、实例信息、Vault 相对目录和本次可分析的笔记。每篇笔记有库内相对路径 `path`、正文 `body`、已解析属性 `properties`。专项自有的属性和取值约定由模板作者在首页说明。
- 检查项可设置 `"linkEvidence": true` 请求本次解析的内部链接。获准运行的脚本可读取 `links[note.path]`，其中 `complete` 表示当前解析器的链接清单可用，`references` 中的每项都有 `status`（`resolved`、`missing` 或 `unknown`），并可包含原链接目标 `target`、1 起计的 `line`、已解析的 Vault 相对 `path` 和 Markdown 目标声明的 `visibility`（`public` 或 `private`）。桌面使用 Obsidian 的实际解析，离线只确认有路径依据的目标。跨库目标只提供其解析路径及可确认的可见性标记。若链接或可见性证据不足，应在结果中标明待核实。
- 函数返回的每条诊断都要有稳定的 `code`、`severity`（`error`、`warning`、`info`）和给用户看的 `message`。能定位时提供相对文件 `file`、从 1 开始的行号 `line`，可在短字符串 `evidence` 中记录依据。消息以普通文字渲染，颜色、图标和定位由插件提供。检查不得修改知识库。专项由本机 Node 进程执行，具备当前用户权限；声明不能给自身授信。
- 可以直接返回诊断数组，也可以返回 `{ findings, unverified }`，其中 `findings` 是诊断数组，`unverified` 是 0 到 5000 的整数。大于 0 时检验状态为 `partial`，适合用 `info` 诊断给出待核实的位置与原因。
- `dependencies` 填可选工作流所需的 Obsidian 社区插件 ID。在首页写清每项依赖的用途、用户触发方式和输出位置。保持 DataviewJS 关闭。模板不复制宿主 `.obsidian`，不设置开库宏或全局新建文件触发器。旧式 `managed` 的 `knowledge.base:overview-bindings` 保留给已有融合总览格式。

## 离线检验和日志

建库时插件会分发 `checks/kb-check.cjs` 和 `checks/common/`，并在实例 README 中列出运行方式。请将模板专项放在 `checks/` 下的其他路径，保留现有 README 正文。从新实例根目录执行以下命令。

```sh
node ./checks/kb-check.cjs --library . --list
node ./checks/kb-check.cjs --library . --checks project-result --trust-digest "替换为已审阅脚本的64位SHA256"
node ./checks/kb-check.cjs --library . --checks all
```

每次运行输出一个 UTF-8 JSON。agent 先读 `status`、`checks[].status` 和 `checks[].coverage`，再用 `checks[].diagnostics` 的位置与证据定位问题。离线缺少 Obsidian 实际链接解析结果时，会报告无法确定。本库 `.log/` 中保存以 UTC 时间和运行 UUID 命名的 JSON 历史，默认由 Git 忽略。修复后重新检查同一组规则，比较两次报告。运行失败、日志失败或部分覆盖时应保留相应原因。

实例中的通用规则和模板专项接收不同的输入。编辑通用规则时，可从对应的 `checks/common/*.mjs` 查看该项可用的证据。例如 `properties.mjs` 接收 `notes` 和宿主初始化的 `result`，累加 `result.coverage`、填入 `result.diagnostics` 后返回 `result`。模板专项则直接返回诊断数组。两种脚本均可使用 `file` 和从 1 开始的 `line` 定位问题。桌面运行修改后的规则需要重新审查源码并授权，CLI 可重复传入 `--trust-digest` 分别认可多个文件。

## 把模板纳入内置目录

1. 选定一个主用途，在 `assets/templates/<purpose>/<id>/` 放置模板。已使用的用途有 `starter`、`collections`、`research`、`reading`、`learning`、`engineering`、`projects`、`writing`、`ai-workflows`。
2. 在 `sources` 数组中逐项填写上游 URL、作者 `author`、固定提交 `commit`、许可 `license`，可加上游子目录 `path`。在模板许可说明中区分实际复用的文件与独立编写的适配，保留所复用作品要求的署名和许可。参考子模块供作者对照，构建直接使用适配后的目录。
3. 保留方法本身的区别。为每套模板准备可用的首页、页面模板、示例与专项。在 Base 或 Dataview 明确限制实例目录，保留原有属性筛选。对共有的附件名、引用和插件写回路径逐项检查。
4. 在刚建好的实例上先运行通用检验，逐条核对错误。融合模板的分类入口用 `![[{{base_path}}]]` 表示用户要在插入页面后填写的 Base 路径。首检应提示待实例化；填入一个不存在的 Base 后，检验应定位到新页面上的嵌入。
5. 在同一测试 Vault 再建一个同构实例。打开首页、笔记、附件、Base，实际执行工作流，确认读写目标均属于预期实例。注入一条本模板特有的问题，验证桌面和 CLI 的代码、严重程度和文件定位一致。修复后复检并回读日志，最后核对两个实例的 Git 状态。
