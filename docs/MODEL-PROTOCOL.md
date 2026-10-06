# 映流 Studio 模型与对话协议

正常应用只提供用户配置的 `custom` 模型服务。默认地址是 `https://api.deepseek.com/v1`、模型是 `deepseek-chat`；没有 Key 时，界面引导配置，服务在创建工程或持久化 pending 回合之前拒绝 AI 请求。应用不会读取 DSH、Codex 或其它应用凭据。离线 `demo / offline-director` 只允许测试显式构造 `ProviderManager(...,{allowFixtures:true})`，不出现在正常供应商目录。

本次开发验证使用离线单元测试和本地 mock gateway，未执行真实付费请求。`/models` 可访问、源码成功保存、运行检查通过、用户观看、真实供应商创作是不同证据；不可互相替代。

## 服务与参数

`/chat/completions` 使用同一个多轮 `messages`，支持 SSE 和普通 JSON 回复。Key 只交给注入的 `SecretStore`；应用配置保存 `hasKey` 状态所需的非敏感字段，不保存 Key。服务错误中的 Key 被脱敏。`ProviderManager.save()` 串行合并更新，采用唯一临时文件原子替换；写入失败会恢复此前的凭据值。

可编辑参数与应用范围：

| 参数 | 默认 | 范围 |
|---|---:|---|
| `temperature` | 0.7 | 0–2 |
| `maxTokens` | 7000 | 256–32768；具体模型可另有上限 |
| `requestTimeoutMs` | 90000 | 5000–300000 毫秒 |
| `contextMessageLimit` | 24 | 4–100 条历史消息 |
| `contextCharLimit` | 90000 | 8000–300000 字符的文本预算 |
| `supportsVision` | false | 用户确认供应商/模型支持图片输入 |
| `enableVision` | false | 用户明确开启图片发送 |
| `maxVisionImages` | 3 | 1–3 |
| `maxVisionBytes` | 6291456 | 1024–6291456 字节，总和 |
| `maxVisionDimension` | 4096 | 64–4096，最长边 |

参数上限是应用保护范围，不保证所有供应商都接受。服务端拒绝会明确呈现。上下文优先保留最近对话，再附当前工程、选中镜头、素材元信息和工具回执；超过预算时截断旧文本，不截断图片 data URL。应用不保存或展示模型的隐藏思考过程。

“检查连接”仅显式调用 `GET /models`，不自动触发创作。删除 Key 使用 `providers.save({apiKey:''})`。

## 闲聊、讨论、创作与修改

`ChatInput.intent` 可显式选择 `auto / chat / discuss / create / modify`；未提供时由明确语句和模型计划共同识别。闲聊和讨论只回答，不自动创建工程或启动预览。讨论后，用户可以继续说“开始制作”。已有工程的修改先读取当前版本，保留未要求修改的手动内容。

模型返回 JSON 导演计划。一次对话最多 4 轮，每轮最多 16 个动作。`done:false` 可以请求读取工程或源码回执；修改在内存候选工程中规划，直到 `done:true`。包含读取动作的计划须先实际读取并把回执返回模型，即使模型误写了 `done:true`，也不会直接宣称已读或提前提交。应用先校验所有动作、镜头主链、素材引用和源码，再执行一次事务：新工程 `create({project,sources})`；已有工程 `apply({projectId,expectedRevision,project,sources})`。计划末尾的无效动作不会留下前面动作的部分修改。

示例：

```json
{
  "intent": "modify",
  "message": "第二镜改为滑入，保留手改标题",
  "done": true,
  "actions": [{
    "tool": "video_update",
    "arguments": {
      "expectedRevision": 5,
      "update": {
        "shotPatches": [{
          "id": "existing-shot-id",
          "patch": {"params": {"motion": "slide"}, "durationSeconds": 8}
        }]
      }
    }
  }]
}
```

五类工具语义：

| 动作 | 支持的行为 |
|---|---|
| `video_project` | 查看当前工程；用户明确新建时规划新工程简报 |
| `video_update` | 项目标题/主题/target/时长；1–12 镜的首次分镜与对应源码；添加、删除、重排镜头；镜头标题/时长/参数；选中镜头；绑定已导入素材；局部源码更新 |
| `video_inspect` | 已有工程/镜头规范与可选源码读取；当前不返回截图像素 |
| `video_render` | 提交后预览和代码运行检查；MP4 导出由界面发起 |
| `video_audio` | 已导入音轨的添加、更新、移除；不从任意路径导入或自行发起远程合成 |

首次分镜使用 `storyboard.shots` 和对应的 `sourcesByIndex`。镜头数量按内容为 1–12；每个新增镜头必须有源码。已有镜头通过 `shotPatches` 保留 ID。新增镜头使用 `addShots:[{tempId,afterId?,...,source}]`，应用分配 ID；`shotOrder` 可以引用既有 ID 或该计划的 `tempId`。`deleteShotIds`、`assetBindings`、`selectedShotId` 分别承担删除、素材绑定与选择。不得用全量 storyboard 覆盖已有非空主链。

“第二镜”“第十二个镜头”按当前主链顺序定位。局部修改限制到选中或明确指定的镜头；删除/添加/重排须与用户请求相符。标题未被明确要求改变时保留。源码由 `html/css/js` 构成，JS 导出 `render(ctx)`，可导出异步 `ready(ctx)`，按帧独立求值并读取 `ctx.params`。

JSON 格式或本地规划校验错误会返回未提交回执，供有限修复。已知工程版本冲突会读取最新工程并要求模型合并，不能覆盖用户的新修改。I/O 或不明事务失败不会自动重复提交。提交后的预览失败保留已保存版本，回合标记失败并明确需要修复或撤销，不静默回滚内容。

## 持久回合、取消与重试

`Conversation.messages` 保留聊天内容，新增 `turnId/status`；`Conversation.turns` 保存每轮请求、时间、状态、重试来源、错误及已提交 revision。状态为 `pending / succeeded / failed / cancelled / interrupted`。聊天记录按工程 ID 的 SHA256 文件名保存在应用数据目录的 `conversations/`。工程创建前的讨论可在创建后关联到工程。

重试复用 `chat.send({retryTurnId,message:'',projectId,provider:'custom',model})`，重新读取当前工程，不复用过时 revision。重启读取历史时，残留 pending 回合转为 interrupted 并落盘；不自动重投可能已执行的事务。

`cancel()` 中止模型信号并仅取消本轮拥有的本地任务。`activity()` 和 `hasActiveTurn()` 供桌面退出流程识别未完任务。退出需 `await shutdown()`，等待取消回合与持久化写入收尾后再关闭后端。

## 明确授权的图片输入

图片发送同时需要：模型配置 `supportsVision:true`、用户 `enableVision:true`、当前请求 `allowImageUpload:true`，以及明确 `imageAssetIds`。不会自动发送所有工程资产。选中镜头存在时，图片必须属于该镜头的生产或参考素材；未选中时也仅发送明确列出的资产 ID。

每轮最多 3 张、总计 6 MB、最长边 4096 像素、每张总像素不超过 16,777,216。工程路径通过 `projectPath` 校验，拒绝绝对路径、越界与符号链接；读取前后核对字节，读取文件签名和实际尺寸，支持 PNG/JPEG/WebP。超限时明确报错，用户先导入较小素材。图片以 data URL 发送到当前配置的模型服务，不写入聊天记录。有限修复的后续请求仍使用本轮明确选中的图片，移除较早请求中的重复图片块，以确保当前请求内的图片数量和字节上限。回合只记录实际发送的 asset ID。

未启用时只有文字/素材元信息进入模型。发送原素材像素仍不代表模型观察了渲染帧。`video_inspect` 当前返回源码与元数据，运行检查回执也不能宣称视觉验收。模型回复误称未发送图片的视觉观察会被替换为准确的元数据说明。

## 设计配方与验收

`packId` 可选择内置配方作为本轮简报参考；未选择时不会把所有配方塞入导演上下文。配方保持 `design_proposal`，不是已实现且已通过美术验收的风格渲染器。实际生成代码、运行检查、画面观看和媒体导出分别验收。

生产 mock gateway 示例在 `tests/model-gateway.ts`，可用于本地 HTTP/Electron E2E；它只测试真实 custom 协议与应用交互，不证明真实供应商创作质量。DeepSeek 请求参数与完成原因依据[官方 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)；本应用没有强制启用 JSON mode，因为兼容服务的支持情况不同，采用提示格式和有限修复。
