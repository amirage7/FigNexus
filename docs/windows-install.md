# FigNexus Windows 安装指南

支持 Windows x64、Figma 桌面端和 Codex。安装包包含 Node 运行环境、依赖和插件编译结果，无需额外 API key。

![首次安装流程](images/setup.svg)

## 1. 安装本机服务与 Codex 接口

从 [Releases](https://github.com/amirage7/FigNexus/releases/latest) 下载 Windows ZIP，完整解压，双击 `install.cmd`。查看配置预览，输入大写 `YES` 回车。

它会安装本机服务、备份并合并 Codex MCP 配置，保留其他服务。安装完成后自动启动服务并进入 Figma 首次设置。无需手动编辑 Codex 配置，也无需安装另一款 Codex 插件。

## 2. 选择自己的插件 ID

在 Figma 桌面端打开可编辑文件：`Plugins → Development → New plugin`。选择 Figma Design / Custom UI，保存生成目录。

回到设置窗口，选择刚生成目录内的 `manifest.json`。这里只读取你的插件 ID，不需要修改源码或编译。

## 3. 导入安装好的 FigNexus

在 Figma 进入 `Plugins → Development → Import plugin from manifest`，选择安装器显示的**安装目录/plugin/manifest.json**，运行 FigNexus。

注意两个 manifest 的用途：**Figma 生成的 manifest 用来取得 ID；FigNexus 安装目录中的 manifest 用来导入和运行插件。**

默认安装目录是 `%LOCALAPPDATA%/FigmaAIBridge/releases/<版本标识>`。数据在 `%LOCALAPPDATA%/FigmaAIBridge/data`。文件夹保留历史名称以兼容升级。

## 4. 配对并开始设计

重启 Codex 一次。在插件点击“配对本机”，核对插件与本机确认窗口六位数字一致，点击“是”。助手自动弹出，无需自己打开，也无需复制令牌。

![配对状态，数字为演示值](images/pairing.png)

显示在线后开启“允许创建和编辑”，在 Codex 说：“使用 FigNexus，在当前页面创建一个登录页。”

## 以后怎么用

打开 Codex → 在 Figma 运行 FigNexus → 自动在线 → 开启编辑 → 在 Codex 说需求。需要少占位置时点击“折叠”，保留小状态条即可。关闭插件会离线，重开后编辑权限默认关闭。

Codex 尚未运行或首次设置跳过时，双击安装目录的 `开始使用.cmd`。配对失败时检查本机弹窗是否在其他窗口后面；取消后等待 10 秒再试。“连接设置”中提供重新配对、备用连接和清除配对。

## 升级与卸载

升级：解压新包运行 `install.cmd`，仅替换验证属于本安装的 MCP 配置，保留配对和日志。新版本需要在 Figma 导入对应安装目录的 manifest；可以复用原来生成的插件 ID。旧服务占用 3055 时，关闭自己的旧版本后再启动。

卸载：双击 `uninstall.cmd`，备份配置并移除本安装的 Codex 条目；保留数据和程序，不删除设计，也不结束其他进程。确认不再需要后可自行清理安装目录。

安装器遇到陌生的 `figma-ai-bridge` 配置条目会报冲突并保留原配置。不要因此删除其他服务。自定义目录可使用 PowerShell 脚本的 `-CodexHome` 和 `-DataRoot` 参数。

## 已知限制

后台或最小化时 Figma PNG 导出可能等待渲染。任务会保留，可以稍后取回；必要时恢复 Figma 前台。读写连接正常不代表 PNG 已完成。此版本没有验收其他客户端，也尚未在每一种干净 Windows 环境完整实测首次安装。
