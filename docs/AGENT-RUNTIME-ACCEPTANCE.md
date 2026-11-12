# 内置 Agent 施工与验收记录

日期：2026-11-09。基线：远端 `711cea491833900b875d6825053474488196997e`。分支：`feat/standalone-agent-runtime`。

本次仅修改独立版 `yingliu-studio`，没有修改视频插件、DSH 宿主，也没有发布发行版。模型相关验收只使用 localhost 网关和测试 fixture，不调用真实计费供应商。

## 已交付

| 施工层 | 实现 |
| --- | --- |
| 事务存储 | worker 内置 SQLite、不可变版本、HEAD/历史/成功回执同事务、版本 CAS、创建租约恢复、旧工程备份迁移 |
| 单任务推进 | 独立 session、账本状态、累计预算、四轮规划、候选先验后提交、已提交恢复只重验、未决供应商调用禁止重发 |
| 成员协作 | 实际模型成员 loop、真实身份授权、单层委派、两成员执行槽、两结果验收队列、父子代次栅栏、accepted 才释放依赖 |
| 上下文与界面 | 授权镜头摘要、源码分页、产物引用、有限 Team 记忆、一次性 subagent 归档、session 切换、阶段/预算/等待原因、准确恢复操作 |

工程库索引也已迁至 SQLite，避免两个进程创建或登记工程时覆盖彼此的目录索引。预览和候选运行目录按版本隔离；导出固定输入版本，完成后安全追加输出记录。旧生成入口也记录供应商调用意图，不能绕过新版幂等约束。

## 最终验证

| 验证命令／环境 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | **319/319 通过**，0 失败、0 取消、0 跳过 |
| `npm run build` | UI、Web、Electron 主进程和 preload 构建通过 |
| `npm run verify:models` | 真实 Chromium **11/11 通过**；无未捕获页面异常 |
| `npm run verify:film` | 真实 Chromium／FFmpeg／ffprobe **7/7 通过** |
| `node scripts/package-app.mjs` | Linux x64 portable 包构建通过；未签名、未发布 |
| `node scripts/verify-package.mjs --layout-only` | **7 项通过、1 项 GUI 跳过**，报告为 `PARTIAL` |
| Node 22.18 存储专项 | **9/9 通过**，包含实际子进程竞争和创建崩溃恢复 |
| `git diff --check` | 通过 |

完整回归覆盖以下关键失败场景：

- 两个真实 OS 进程从同一 revision 提交，恰好一个成功；相同 operation 并发重放返回同一成功回执；撤销和重启不删除去重记录。
- 创建者在首个 HEAD 前被终止后，原请求可接管过期创建租约；迟到执行者不能提交。测试显式推进租约到期，不把测试时钟推进冒充实际等待 30 秒。
- 媒体任务的两个真实 OS 执行者竞争，仅产生一次 localhost 供应商 POST；响应未知、恢复及远端未决取消不会自动重新生成。
- 同 session 对话／工作流共享占位；不同 session 可推进。旧 generation、越权镜头／字段、伪造身份和失效父租约均拒绝。
- 空动作假完成、残缺源码、失败的浏览器检查、负面视觉结论、重复无进展、未验收子任务均不能直接成功。
- 根代理通过 localhost 导演委派真实独立场景模型 loop，经浏览器验证、接受与最终合并后仅提交一次；完整成员源码不进入主管模型提示。
- 已接受但未提交的候选恢复时重新检查依赖；相关变化拒绝，无关变化保留。Team 仅复用受限摘要，subagent 归档后不再授权。
- 旧对话、撤销历史、便携包回读、版本预览隔离、源码固定版本读取、导出与并发编辑保持一致。
- 快照读取不会拼接“旧工程版本＋新任务完成状态”；该竞态有确定性门闩回归测试。

Chromium 界面验收实际运行两个并行根 session，验证较早回包不覆盖当前会话、取消 A 不影响 B，以及暂停后继续原 task 时 generation 递增。

成片验收输出 6 秒、72 帧、H.264 yuv420p／AAC 的 MP4，完整解码通过，三段语音均非静音。关键帧的候选验证与提交后像素一致，导出后仍可保存源码为新版本。图片、视频、旁白和视觉结论来自 localhost fixture；这验证协议、媒体和运行链路，不代表真实模型的美术或主观音质验收。

## 本机产物

以下产物位于忽略目录，未加入 Git 或发行版：

- `artifacts/acceptance-multimodal/ui-verification.json`：最终 11 项界面验收。
- `artifacts/acceptance-multimodal/parallel-sessions.png`、`session-cancellation.png`：会话并发与取消截图。
- `artifacts/acceptance-v03/multimodal-film-1794232262391/report.json`：最终成片报告。
- 同目录 `multimodal-film.mp4`：最终验收成片。
- `artifacts/acceptance-v03/package-verification-linux-x64.json`：迁出源码目录后的 Electron 包验收。
- `artifacts/yingliu-studio-linux-x64`：本机 portable 应用包。

## 未执行的平台检查

当前环境没有 X server／DISPLAY，Electron 桌面 GUI 启动验收明确记为 `NOT_CHECKED`；包检查的 GUI 项明确为 `SKIP`。已实际验证包内 Electron Node 模式、SQLite worker 的启动和事务、依赖解析、应用 HTTP 服务与工程包导入导出，不能把这些结果等同桌面 GUI 通过。

Windows、macOS 原生桌面、系统钥匙环、签名、公证和安装器不在本机已验收结果中。并发范围限同机本地文件系统，不包含 NFS、多机器、新旧应用混合写入。

执行规则见 [协作协议](AGENT-COLLABORATION-PROTOCOL.md)，升级与故障恢复见 [迁移说明](AGENT-RUNTIME-MIGRATION.md)。
