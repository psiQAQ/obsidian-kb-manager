# 构建、验证与平台支持

## 本地验证

在仓库根目录使用 Node.js 24、npm 和系统 Git。打包另需 Python 3。首次安装开发依赖运行 `npm ci`。依赖齐备后依次运行以下命令。

```sh
npm run typecheck
npm run lint
npm test
npm run build
node scripts/verify-mobile.mjs
python scripts/package_plugin.py
```

测试使用仓库内的隔离 Vault，通过系统 Git 核对桌面后端和命令行互操作。移动入口检查使用生产构建的 `main.js`。打包脚本使用 Python 标准库，产物为 `dist/knowledge-base-manager.zip`。参考子模块供作者对照，构建与安装直接使用仓库中的模板资源。[验证工作流](../.github/workflows/lint.yml)

## 构建产物与依赖许可

生产构建先检查 TypeScript，再用 esbuild 从同一份模板目录生成内置资源和官方脚本摘要。Obsidian 加载仓库根的 `main.js`；在终端运行诊断使用 `dist/kb-check.cjs`。两者共享诊断引擎，桌面入口另接入 Vault 元数据缓存，离线入口对没有充分证据的链接报告未验证。[构建配置](../esbuild.config.mjs)

打包脚本核对插件入口的外部导入和参考子模块路径，再根据插件与 CLI 的构建清单收集实际打入包的 npm 依赖许可。ZIP 顶层只有一个 `knowledge-base-manager/` 目录，内含两个入口、插件清单、样式、主许可和第三方声明。用这个 ZIP 在测试 Vault 中安装，可以同时验证界面和 CLI。[打包脚本](../scripts/package_plugin.py)

项目的推送和 PR 工作流在 Windows、macOS、Ubuntu 上执行检查、构建和打包。发布工作流核对标签与清单版本，生成草稿 Release，维护者发布后用户才能从公开发行页下载。[发布工作流](../.github/workflows/release.yml)

## 发布前在官方目录预检

维护者在 Obsidian 社区目录的 **Plugins → Your entries** 打开本插件，选择 **Review branch**，填入已推送的候选提交 SHA，选择 **Run preview scan**。使用 SHA 可以让复查对应同一份源码。查看清单、发行资产、源码和构建核验各栏，记录错误及对应提交。若条目尚未认领，先按官方目录的条目管理流程办理。[Obsidian 官方条目管理说明](https://docs.obsidian.md/community-directory/manage-entry)

## 桌面与移动端

3.0.2 已在 Windows 的 Obsidian 1.15.1 验证。1.0.0 的三系统自动化留有历史记录；该记录不涵盖 macOS 或 Linux 的原生 Obsidian 桌面交互。[历史 CI 记录](https://github.com/psiQAQ/obsidian-kb-manager/actions/runs/44349627803)

当前发行清单仅开放桌面安装。Android 和 iOS 共用的移动入口使用 Obsidian 文件接口与内置 Git。移动代码和自动化样例覆盖建库、目录模板、状态、历史、暂存、提交和 HTTPS 同步；3.0.2 已模拟加载移动入口，本版本未做移动真机验收。

手机端支持逐库覆盖 Git 姓名与邮箱，缺少的字段取自本设备为当前 Vault 保存的默认身份。默认身份和远端登录凭据使用 Obsidian SecretStorage。移动 HTTPS 需要服务器允许 WebView 跨域请求，并使用无需重定向的仓库 URL；SSH 操作使用桌面版。

### 移动端开放条件

Android 与 iOS 各使用一个测试 Vault，记录 Obsidian、系统和候选构建版本。分别从移动入口创建两个同模板库、重新打开应用、核对每个实例的首页和附件，再完成一次状态查看、暂存、提交与经授权的 HTTPS 测试同步。核对触摸与窄屏下的确认操作、切到后台后的恢复，以及桌面专用操作在移动界面的可见性。按系统和功能记录通过项、失败项及复现步骤，再据此决定发行清单可开放的能力。

## 来源与许可

模板目录列出每套模板的来源和许可，融合 LLM Wiki 还单列了引用资料。离线包中的 `THIRD_PARTY_NOTICES.md` 汇总模板及随包代码的许可。[模板来源](template-catalog.md) · [融合模板许可](../assets/templates/ai-workflows/llm-wiki/LICENSES.md)
