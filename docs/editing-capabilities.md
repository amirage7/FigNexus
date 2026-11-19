# 已有内容编辑

更新后需要重新构建并加载 MCP、Bridge 和 Figma 插件，再刷新客户端工具清单。插件中开启「编辑」。以下独立接口均要求 sessionId、expectedPageId 和稳定的 requestId。

| 工具 | 参数与作用 |
| --- | --- |
| figma_clone_node | target，可选 name/parent/x/y；原生复制整棵树，保留文字、图形、图片填充及层级 |
| figma_update_text | target/characters，可选 fontFamily/fontStyle/fontSize/fill/locked；直接替换原文字 |
| figma_update_node | target，可选 name/x/y/width/height/fill/opacity/visible/locked |
| figma_delete_nodes | targets 数组，1–25 个节点；本地确认后删除并保留备份 |
| figma_edit_nodes | operationsJson，1–25 项严格验证的操作数组；复用 figma_execute 操作白名单 |

fontFamily 和 fontStyle 必须同时传入。只修改文字时不主动改变对齐、颜色、尺寸模式。混合格式按原字符索引保留区间，新增尾部文字继承最后一个区间的格式；显式字体、字号、填充覆盖在替换后应用。缺失字体在修改前返回具体字体名称。真实 Figma 排版仍需验收。

所有 x/y 都相对父级，回读包含 parentId 和 coordinateSpace:"parent"。locked:false 可显式解锁目标自身；祖先锁定、实例内目标和备份容器仍不可编辑。

## 复制后编辑后代

将以下数组序列化到 operationsJson：

```json
[
  {"op":"clone","target":"123:1","ref":"copy","name":"流程图副本","x":1200,"y":0},
  {"op":"update","target":"$copy/123:9","patch":{"characters":"新的流程说明"}}
]
```

$copy 指副本根节点，$copy/123:9 指原节点 123:9 对应的副本后代。复制项 results[index].idMap 返回完整原 ID → 新 ID 对照，不依赖图层名称。每批最多映射 100 个节点，并受响应字节预算限制；超限在复制前拒绝，不截断映射。不能把副本放到原树内部，以保证原图不变。

批量接口也支持 reorder、reparent、layout。高级 patch 支持现有 fills/effects/stroke/vectorPaths 等字段；仅接受声明的结构化数据，不执行代码。绑定节点的箭头和文字溢出检测尚未实现。

## 结果、重试和撤销

保留 complete/created/refs/completed/failed/skipped/backups，新增：

- status：none（没有保留的修改）、partial（失败前有完成项、备份或残留变化）、complete（全部完成）。
- results：按输入顺序给出 completed/failed/skipped，包括实际节点回读、删除 ID、复制映射和错误。
- residualIds：失败后未能清理的本次对象 ID。失败项可能已部分修改，应读取其 node，不能将失败当作未执行。
- charactersTruncated、fillsTruncated、fieldsTruncated：明确标记回读中被裁剪或省略的字段。操作状态和复制 ID 映射保留完整。

失败后停止后续操作；已完成项不自动回滚。混合批次只在末尾调用一次 commitUndo；实际一次撤销效果仍需真实 Figma 验证。

删除首次返回 CONFIRMATION_REQUIRED。在本地插件确认后，用**相同 requestId 和完全相同参数**取回执行结果。请求缓存继续防止同一次插件运行中重复写入；插件重启后结果未知时，不自动重放。

## 私有插件数据与 manifest ID

无 ID 的开发 manifest 仍可直接导入。编辑备份和变量所有权、历史记录依赖私有插件数据，缺少有效身份时返回 PLUGIN_DATA_UNAVAILABLE，并尽量在创建对象前拒绝。

开发环境使用 **Figma 实际分配给你的数字插件 ID**：

```powershell
pnpm plugin:id <Figma分配的数字插件ID>
pnpm build
```

重新导入 apps/figma-plugin/dist/manifest.json 并重启插件。不要自行编造 ID。发行包继续移除开发者的本地 ID，安装器保留或复用用户已有真实身份。无法自动确定用户身份时，需由用户提供。

## 验证边界

自动测试覆盖工具发现及分发、复制映射与原图保留、文字区间恢复、锁定约束、部分失败和残留、响应大小、缺失身份预检、请求缓存和混合批次撤销提交次数。

测试使用 Figma API 替身；包含图片和混合字体的真实复制、真实排版与一次撤销，需要重新加载新版插件后在测试文件中验收。测试不会自动改动用户当前画布。
