# FigNexus

**在 Codex 中描述需求，在 Figma 中创建可编辑的设计。**

FigNexus 连接 Codex 与 Figma，可以读取画布、创建和修改界面、导入图片、导出 PNG。文字、形状、渐变和矢量路径都能继续在 Figma 中调整。

支持 Windows x64、Figma 桌面端和 Codex。

![FigNexus 面板与折叠状态条（示例）](docs/images/panel.png)

## 安装

下载 [最新 Windows 安装包](https://github.com/amirage7/FigNexus/releases/latest)。安装包包含运行环境、Figma 插件和 Codex 连接配置。

![安装流程](docs/images/setup.svg)

1. 解压安装包，双击 **开始使用.cmd**。
2. 查看安装预览，输入 `YES`。安装完成后，窗口会显示 `manifest.json` 的完整路径。
3. 在 Figma 中选择 **Plugins → Development → Import plugin from manifest**，选择该路径的文件。
4. 运行 FigNexus，点击 **配对本机**，核对弹窗中的六位码并确认。
5. 重启 Codex，完成首次设置。

详细步骤见 [Windows 安装指南](docs/windows-install.md)。

![本机配对与在线状态（示例）](docs/images/pairing.png)

## 使用

打开 Codex，再在 Figma 中运行 FigNexus。Codex 会自动启动本机服务，插件通过保存的配对自动连接。

插件显示“在线”后，就可以在 Codex 中提出设计需求。修改画布前，打开插件的 **编辑** 开关。

**检查连接：**

> 使用 FigNexus，读取当前文件、页面和选中节点。

**创建界面：**

> 使用 FigNexus，在当前页面新建一个 390×844 的登录页。背景用蓝紫渐变，文字和按钮保持可编辑，图标用矢量路径。完成后导出 PNG。

**修改设计：**

> 使用 FigNexus，把选中的卡片改成蓝紫渐变，调整文字和按钮的间距。

**根据参考图复刻：**

发送图片，并说明目标页面和尺寸，例如：

> 使用 FigNexus，在当前页面新建 Frame，复刻这张图，尺寸为 1440×900。

## 面板操作

- **折叠：** 缩成小状态条，保持连接。
- **编辑：** 开启后可创建和修改节点。每次重开插件时，编辑开关默认关闭。
- **连接设置：** 管理配对，切换备用连接。
- **删除确认：** 查看具体删除请求，在插件中确认后执行。
- **备份恢复：** 修改前保存节点备份，恢复时生成副本。

使用期间保持插件打开；关闭插件会结束连接。

## 主要功能

| 功能 | 支持内容 |
| --- | --- |
| 画布读取 | 文件、页面、选中内容与节点查询 |
| 创建与编辑 | Frame、文字、形状、线条、矢量路径、Auto Layout |
| 视觉样式 | 线性、径向、角度、菱形渐变，描边与阴影 |
| 图片 | 本地 PNG/JPEG 导入，裁剪与平铺填充；单张上限 2 MiB |
| 设计系统 | 本地组件、实例、变量与绑定、多页面 |
| 备份与记录 | 节点备份、恢复副本、本地操作日志 |
| 预览 | PNG 导出与图片读取 |

## 常见问题

**插件离线**

确认 Codex 和 FigNexus 已打开。可以双击 `开始使用.cmd` 手动启动服务，或在插件的“连接设置”中重新配对。

**画布无法编辑**

确认你有当前文件的编辑权限，并打开插件的“编辑”开关。

**PNG 导出等待较久**

Figma 在后台或最小化时，渲染可能暂停。将 Figma 切到前台，保持插件打开，再让 Codex 取回同一项导出任务。

**升级版本**

解压新安装包，双击 `开始使用.cmd`，再将安装完成后显示的 `manifest.json` 导入 Figma。配对和日志会保留。

## 开发

源码使用 TypeScript、React、Fastify、WebSocket 和 MCP SDK。开发环境为 Node.js ≥22.16，pnpm 版本见 `package.json`。

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @bridge/plugin check:main
pnpm test
pnpm build
pnpm smoke
```

构建后，在 Figma 导入 `apps/figma-plugin/dist/manifest.json`。`pnpm build:windows` 生成 Windows 安装包。

`pnpm smoke` 使用模拟插件验证接口，需要 3055 端口空闲。真实 Figma 验收脚本会操作画布，请在测试文件中运行。

项目结构、接口和验证记录见 [架构说明](docs/architecture.md) 与 [验证范围](docs/verification.md)。第三方许可随安装包提供；项目许可证尚待确定。
