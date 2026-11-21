# 运行和解读知识库检验

在桌面管理器打开目标库的 **… → 检验**。可以单选检查项，也可以选择 **运行全部适用项**。如果准备移动或克隆这个库，单独勾选 **可移植性** 并运行所选项。

| 想确认的事情 | 选择与结果 |
|---|---|
| 笔记、附件和清单能否正常使用 | 通用项检查清单与登记、属性语法、链接与嵌入、标题与块、Canvas、Bases 和受管绑定。报告按严重程度给出规则编号、文件和可用的位置。 |
| 单独搬走这个库会缺什么 | 可移植性列出已解析的跨库依赖。Canvas 的文件节点、分组背景、文本链接也在范围内；同名候选与实际目标分别标明。 |
| 内容是否符合所选模板的组织方式 | 选择模板声明的专项。比如新版知识花园会对拟分享笔记指向私有页面的链接发出警告。桌面使用 Obsidian 实际选中的目标。 |

同时看**严重程度**和**覆盖情况**。例如，图片引用已确认跨库，另一篇 Markdown 又无法读取，同一份报告会同时显示警告和「部分完成」。展开对应检查可看到文件和原因。离线短链缺乏 Vault 索引时也可能显示未验证。

## 专项脚本与日志

模板专项通过本机 Node.js 运行，脚本拥有当前系统账号的文件和网络权限。内置脚本按发行包中的摘要识别；个人脚本通过检查项旁的 **审查脚本** 查看源码和 SHA-256，再选择 **信任此版本**。脚本内容改变后需重新核对。请只运行你信任的脚本。

通用检验读取清单、笔记、附件引用及宿主提供的元数据，保留笔记内容、Git 暂存区和提交历史。新建实例会在默认由 Git 忽略的 `.log/` 保存每次检验的 JSON 报告；受管路径的修复在独立的预览中确认。模板专项须遵循只读约定。离线 agent 可调用 ZIP 中的 `kb-check.cjs` 并读取报告的 `status`、各项 `coverage` 和 `diagnostics`。[专项脚本协议](template-authoring.md)

## 离线运行与读取报告

在离线包的插件目录中打开终端，将下面的路径换成实际的 Vault 和知识库路径。`--list` 列出本库声明的专项，`--checks all` 运行全部适用项，可移植性可用 `--checks portability` 单独运行。

```sh
node kb-check.cjs --library "/path/to/Vault/knowledge-base/光学研究" --vault-root "/path/to/Vault" --list
node kb-check.cjs --library "/path/to/Vault/knowledge-base/光学研究" --vault-root "/path/to/Vault" --checks all
```

CLI 将报告作为单行 JSON 写到标准输出。若两库都有 `[[实验记录]]`，桌面可以查询 Obsidian 在当前来源页选中的目标；单选可移植性可查看同名候选。离线只有短链时，保留报告中的未验证原因。agent 即使收到退出码 0 也应读取报告，例如将上条命令的输出保存为 `report.json` 后运行：

```sh
node -e "const r=JSON.parse(require('node:fs').readFileSync('report.json','utf8')); console.log(r.status); for (const c of r.checks || []) console.log(c.id,c.status,c.coverage,c.diagnostics)"
```

退出码 1 表示报告含错误级诊断，2 表示运行或日志失败、脚本尚未授信，或参数无效。个人脚本可在核对实际文件后用 `--trust-digest` 指定认可的摘要；自定义 Vault 配置目录用 `--config-dir` 指定目录名。

运行检查、列出专项（`--list`）和读取历史（`--history`）都使用指定的 Vault 范围。若列出专项或读取历史时收到退出码 2，先核对 `--library` 是否位于 `--vault-root` 内，以及路径是否误指向 Vault 配置目录。
