# FigNexus 架构

Codex → stdio MCP Server → 本机 Bridge → 插件 UI 通信层 → Figma Plugin API 主线程。

本机服务只监听 `127.0.0.1:3055`，插件使用 `localhost` 的 WebSocket，提供 HTTP 备用连接。Codex 启动 MCP 时检测或启动本机服务；插件发起首次配对时，服务自动打开本机六位码确认窗口。

## 分层

- `packages/protocol`：严格 Zod schema、操作白名单和大小限制。
- `packages/core`：会话、串行队列、请求关联、超时和缓存。
- `apps/bridge-server`：认证、WS/HTTP、配对、脱敏审计、预览资源。
- `packages/mcp-server`：34 个 MCP 工具及本机启动器。
- `apps/figma-plugin`：网络、保存配对、本地权限、原生节点读写和导出。
- `apps/pairing-helper`：本机启动和人工配对确认。
- `scripts/distribution`：封装运行环境、配置备份合并、直接导入说明、已有 ID 复用和卸载。

## 权限与恢复

随机配对令牌保存在本机。WebSocket 首帧与 HTTP Bearer 验证令牌，不放在 URL 中；日志脱敏。源代码与发行包不附带预设令牌或使用者的 Figma ID。

插件每次运行默认关闭编辑，需要本地开启。异步查询和字体加载后复检权限、页面、执行期限；重连不会自动重放写入。删除还需要绑定具体批次和请求 ID 的本地确认。修改前保留原生节点备份，恢复创建新 ID 的副本，保留原节点与备份；不提供整文件事务或原位覆盖回滚。

UI 折叠只改变面板尺寸，同一连接和主线程继续运行。关闭插件会结束会话。PNG 调用 Figma 的 `exportAsync`，超时保留在途请求及迟到结果；后台渲染的完成时间由 Figma 决定。

## 兼容性

`figma_create_frame`、`figma_create_text`、`figma_create_rectangle` 使用浅层参数，`figma_create_nodes` 接受最多25项的 JSON 创建数组；即使客户端未暴露复杂的 `figma_execute`，仍可创建原生可编辑图层。JSON 仅为严格验证的数据，不执行脚本，也不允许编辑或删除。各入口复用原执行器、权限、审计、请求ID保护，并将 expectedPageId 传入插件，在写入前校验页面。更新需要同时加载新版 MCP、Bridge 与 Figma 插件；客户端会话也需要刷新工具清单。

独立编辑入口包括 `figma_clone_node`、`figma_update_text`、`figma_update_node`、`figma_delete_nodes` 和 `figma_edit_nodes`。复制 ID 映射、后代引用、逐项结果与身份要求见 [已有内容编辑](editing-capabilities.md)。

产品显示名称为 FigNexus，服务、MCP 配置和本机数据目录保留历史 `figma-ai-bridge` / `FigmaAIBridge` 标识，避免升级破坏已有配对或配置。不会接入官方 Figma MCP、REST PAT 或任意脚本执行通道。当前验收平台为 Windows x64、Figma 桌面端和 Codex。

Windows 发行包保留 FigNexus 的固定插件 ID，供首次安装写入 Figma 的本机插件存储。升级时优先复用已有的受管理安装身份，保留同一 ID 下的配对和设计数据。构建时校验发行身份，不打包临时备份。版本目录改变后仍需通过 Figma 公开菜单导入新路径。

Windows 统一入口先只读验证安装记录和 Codex 配置。首次或新版本执行安装，确认成功后才使用安装目录内的连接和设置脚本；取消时不启动服务。重复启动不重写配置；较旧的解压启动器会沿用已验证的较新安装，避免降级。启动入口调用安装器时带 SkipStart，避免安装器再次调用启动入口。
