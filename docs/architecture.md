# FigNexus 架构

Codex → stdio MCP Server → 本机 Bridge → 插件 UI 通信层 → Figma Plugin API 主线程。

本机服务只监听 `127.0.0.1:3055`，插件使用 `localhost` 的 WebSocket，提供 HTTP 备用连接。Codex 启动 MCP 时检测或启动本机服务；插件发起首次配对时，服务自动打开本机六位码确认窗口。

## 分层

- `packages/protocol`：严格 Zod schema、操作白名单和大小限制。
- `packages/core`：会话、串行队列、请求关联、超时和缓存。
- `apps/bridge-server`：认证、WS/HTTP、配对、脱敏审计、预览资源。
- `packages/mcp-server`：25 个 MCP 工具及本机启动器。
- `apps/figma-plugin`：网络、保存配对、本地权限、原生节点读写和导出。
- `apps/pairing-helper`：本机启动和人工配对确认。
- `scripts/distribution`：封装运行环境、配置备份合并、直接导入说明、已有 ID 复用和卸载。

## 权限与恢复

随机配对令牌保存在本机。WebSocket 首帧与 HTTP Bearer 验证令牌，不放在 URL 中；日志脱敏。源代码与发行包不附带预设令牌或使用者的 Figma ID。

插件每次运行默认关闭编辑，需要本地开启。异步查询和字体加载后复检权限、页面、执行期限；重连不会自动重放写入。删除还需要绑定具体批次和请求 ID 的本地确认。修改前保留原生节点备份，恢复创建新 ID 的副本，保留原节点与备份；不提供整文件事务或原位覆盖回滚。

UI 折叠只改变面板尺寸，同一连接和主线程继续运行。关闭插件会结束会话。PNG 调用 Figma 的 `exportAsync`，超时保留在途请求及迟到结果；后台渲染的完成时间由 Figma 决定。

## 兼容性

产品显示名称为 FigNexus，服务、MCP 配置和本机数据目录保留历史 `figma-ai-bridge` / `FigmaAIBridge` 标识，避免升级破坏已有配对或配置。不会接入官方 Figma MCP、REST PAT 或任意脚本执行通道。当前验收平台为 Windows x64、Figma 桌面端和 Codex。

开发导入不要求先获取插件 ID。源码生成器允许省略 ID，发行包始终移除本地 ID 和临时备份。安装时仅复用当前 manifest、已保存身份或上次受管理安装内已有的真实 ID；无 ID 时直接导入，不生成随机数字或调用注册 API。版本目录改变后仍需通过 Figma 公开菜单导入新路径。

Windows 统一入口先只读验证安装记录和 Codex 配置。首次或新版本执行安装，确认成功后才使用安装目录内的连接和设置脚本；取消时不启动服务。重复启动不重写配置；较旧的解压启动器会沿用已验证的较新安装，避免降级。启动入口调用安装器时带 SkipStart，避免安装器再次调用启动入口。
