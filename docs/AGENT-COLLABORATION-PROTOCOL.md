# 内置 Agent 执行与协作协议

适用范围：`yingliu-studio` 独立应用。工程写入、会话、成员和工作流使用本机 SQLite 账本；不借用视频插件或 DSH 的身份、上下文、模型与凭据。

## 根任务和工具

1. UI 先创建或选择真实根 session。已有工程写请求携带读取所得的 `expectedRevision`、稳定 `operationId`；新建明确传 `expectedRevision:null`。重放同 ID 不得改变请求参数。
2. 应用创建 task、运行身份、授权和配置快照。客户端或模型不能提供内部 `operation` 对象、`execution` 或 `leaseOwner`。媒体业务的 `operation:"text-to-image"` 等字符串仍是普通业务参数。
3. `agent_tasks` 和 `session_activity` 决定谁可执行。同 session 的对话和旧协作工作流共享占位；不同 session 可以同时计算，工程 HEAD 提交仍须比较版本。
4. 工具先记录意图，后执行，最后写回执。所有模型、下载、浏览器和 FFmpeg 工作在数据库写事务之外执行。租约、generation、父授权和范围在结果提交时再次检查。
5. `done:true` 只是验收申请。修改必须实际产生候选、通过验证并获得提交回执；子任务未收束时，根任务不能提交或宣称成功。

典型 API 调用：

```json
{"endpoint":"sessions.create","payload":{"projectId":"工程ID","name":"第一版"}}
{"endpoint":"chat.send","payload":{"sessionId":"返回的会话ID","operationId":"调用方保存的唯一ID","expectedRevision":3,"projectId":"工程ID","provider":"配置连接ID","model":"配置模型名","message":"修改第一镜标题"}}
{"endpoint":"chat.cancel","payload":{"sessionId":"会话ID","projectId":"工程ID","taskId":"查询所得任务ID","generation":1}}
```

`agent.task.pause/resume/retry/cancel` 同时携带 session、task、generation、operationId。继续和修复还需要当前读取的工程 revision。取消旧任务不能影响新任务；跨进程控制首先写账本，仅对应执行者中止自己的运行。

`operation.get`／`operation.receipt` 用于工程提交对账；`operation.intent` 用于旧生成入口的未决供应商意图。没有远端幂等或查询证据时，结果未知的调用保持阻塞，不把“重新打开应用”解释为再次生成。

## Loop 与恢复

主路径为 `queued → preflight → planning → executing → validating → committing → reconciling → succeeded`。任务数据更新同时检查读取版本和真实租约。界面中的对话回合仅是账本投影。

| 状态／检查点 | 推进规则 |
| --- | --- |
| `paused` | 继续原任务；新执行代次使旧执行者失效 |
| `blocked` | 处理依赖、模型配置、预算或未决调用；不自动重放副作用 |
| `stalled` | 连续相同动作、输入且无新增证据；缩小或修正任务 |
| `awaiting-rebase` | 重新读取依赖和修改范围，重建候选并验证 |
| `awaiting-acceptance` | 候选已验证，等待根代理接受；不释放下游依赖 |
| 已提交但未完成 | 读取提交回执，重验／修复检查；不再次添加镜头或提交原业务动作 |
| `cancelled` | 授权已撤销；明确的新请求才可获得新授权 |

配置快照不包含密钥值。恢复时若连接或模型参数无法匹配，任务阻塞；不会自动改用另一个模型。费用未知记为未知；设金额硬上限且无法可靠报价时，调用前阻塞。

## Team 和 Subagent

- **Team** 是可重复使用的角色会话。每个新任务重新分配范围、代次与预算；只继承最多 4000 字符的已验收角色摘要和经验。
- **Subagent** 是单目标的一次性会话，不继承父聊天。验收、失败或取消后归档并撤权，不把旧会话重新用作执行者。
- 仅根代理委派一层。成员没有再次委派、主版本提交或合并权限。
- 授权绑定 project、session、task、真实运行身份、generation、镜头、字段和工具。模型提供的身份参数不改变授权。
- 同一工程最多两名活动成员、两个待验收候选。待验收队列满时停止新派发。失败分支停止继续派发，完成产物仍保留。

根模型可调用：

| 工具 | 用途 |
| --- | --- |
| `agent_delegate` | goal、role、mode、shotIds，加可选 writeFields、capabilities、dependencies、acceptance；返回任务引用 |
| `agent_wait` | 有限等待指定子任务，返回真实状态与候选 ID |
| `agent_result` | 读取精简状态、候选引用和需主管关注的消息 |
| `agent_accept` | 检查直接父子关系、代次、验证和读取依赖；候选由宿主合并，源码不经过根模型转抄 |
| `agent_cancel` | 同事务校验父租约及子任务代次，取消指定子任务 |

成员只可 `read / execute / submit / blocked`。`execute` 受限于 code、image、video、speech 中获授权的工具。源码读取按单镜头分页，`fields:["source"]` 配 `offset/limit`；`fields:["diff"]` 返回本候选的变化摘要。读取别的成员上下文、任意路径、地址、Shell 或凭据均不是成员工具能力。

消息类型为 `progress / blocked / decision / result`。同任务 progress 合并；根默认只读取后三类及验收队列，详情通过产物 ID 获取。

## 候选、验收和合并

候选可以建立在旧基线上，但始终保存其基线与读取依赖。结构、源码语法、素材引用、真实浏览器关键帧／跳帧／冷载入检查是必需项。音轨使用真实 FFmpeg 混音、解码和时长检查；这不代表主观音质验收。视觉验收必须有本次上传授权、实际帧证据和绑定候选哈希的结构化通过结论；负面结论阻塞采用。

成员产物按 `submitted → validated → accepted` 推进，只有 accepted 释放下游依赖。模型退出、工具完成和任务结束不代替验收。

合并会检查授权范围、源码、素材、目标参数、相关工程字段和时间线依赖。相关数据发生变化则拒绝旧候选；无关变更保留。已经采用但尚未提交的候选通过持久化引用恢复，再检查当前 HEAD；不能简单把旧候选的 revision 替换成最新值。合并后的完整候选还要验证，再以根任务的唯一提交回执发布。

## 固定上限

| 项目 | 默认值 |
| --- | --- |
| 根任务子会话 | 16 |
| 累计模型／工具请求 | 64／128 |
| 累计运行预算 | 30 分钟 |
| 规划 | 最多 4 轮 |
| 每步骤修复 | 首次执行后最多 2 次，仍受总预算限制 |
| 心跳／租约 | 5 秒／30 秒 |
| 媒体排队／生成观察 | 各 20 分钟，到期暂停观察并保留请求 |
| 成员文本上下文 | 模型配置与 24000 字符中的较小值 |
| 成员结果摘要／Team 记忆 | 各最多 4000 字符 |

超限明确阻塞；硬约束不通过截断静默消失。等待成员的根协调器不占成员执行槽。

迁移、数据库故障及便携包规则见 [迁移与恢复](AGENT-RUNTIME-MIGRATION.md)。本机 Linux 的测试不能替代 Windows／macOS 原生平台验收。
