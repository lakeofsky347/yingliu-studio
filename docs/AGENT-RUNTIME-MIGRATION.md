# 内置智能体存储迁移与恢复

本文适用于独立版映流 Studio 的导演、制作成员和协作工作流。它不描述原插件的升级，也不包含真实计费模型验收。

## 升级前后

首次用新版打开旧工程前，必须退出所有仍可能写入该工程的旧版映流进程，并备份工程目录。新旧版本不能同时写同一个工程：旧版已经进入提交阶段的操作不会参与新版 SQLite 租约和事务。完成升级后，多个**新版**进程可以同时打开和编辑同一工程。

旧工程的稳定 ID、revision、历史记录及镜头源码保持不变。没有版本记录的旧工程会先建立一个“导入既有工程”基线；已有 `.studio/state.json` v1 的工程会把当前版本、撤销/重做指针及历史版本索引导入数据库。旧快照文件保持原字节，项目数据结构升级只作用于读取后的内存对象。

迁移完成后：

- `.studio/state.sqlite` 成为工程版本、历史和成功操作回执的权威存储。
- 原 v1 指针保存在 `.studio/legacy-state-v1.json`；备份使用临时文件、同步和原子替换，避免留下半份 JSON。
- `.studio/state.json` 变成 `{ "version": 2, "storage": "sqlite", "database": "state.sqlite" }`，使读取时检查 v1 的旧版程序拒绝该工程。
- `project.json`、镜头目录中的源码文件和 `.studio/projected.json` 是兼容投影，可以由权威快照修复。不能把它们当成最新 HEAD 的依据。

只读查看旧版镜头源码和已有历史不会主动改写 v1 文件。打开、迁移或提交时才建立新版状态。路径存在冲突时，打开操作会在写入迁移元数据或投影前报告错误。

数据库丢失、损坏或快照校验失败时，新版不会回退到可能过期的 `project.json` 或 v1 指针。看到 v2 标记却没有可用数据库会报告 `STORE_DATABASE_MISSING`。恢复旧备份应恢复一个完整、彼此一致的工程副本；只删除 SQLite 或只复制回 `legacy-state-v1.json` 不是降级流程。

## 权威记录与事务

每个工程的数据库包含以下存储表：

| 表 | 关键列 | 作用 |
| --- | --- | --- |
| `store_head` | `singleton=1`, `current`, `revision`, `undo_json`, `redo_json`, `history_group` | 唯一当前版本及历史指针 |
| `store_versions` | `id`, `revision UNIQUE`, `sha256` | 已提交快照的版本索引和内容摘要 |
| `store_operations` | `id`, `payload_hash`, `committed_revision`, `version_id`, `task_id`, `generation` | 成功写操作的持久回执 |
| `store_creation` | `singleton=1`, `operation_id`, `payload_hash`, `project_id`, `owner`, `generation`, `lease_expires_at`, `committed_revision` | 首次创建意图及可接管的创建租约 |

`store_versions` 指向 `.studio/versions/<id>.json`。每份快照包含完整工程数据和全部镜头源码，写入临时文件并同步后，才发布到不可变版本目录。首次加载已登记快照时检查 SHA-256；内存缓存按不可变版本 ID 使用。

提交使用短暂的 `BEGIN IMMEDIATE` 事务，原子完成 HEAD 的 `current/revision` 比较并交换、版本索引、历史和 operation 回执。任务提交还在同一事务中检查 session、owner、generation、租约期限、任务状态以及 `committed_revision IS NULL`，并记录该任务已提交的 revision。因此同一根任务最多发布一次主版本；重新规划也不能绕过此限制。工作流和媒体任务使用独立的 `service_records` 栅栏，检查 owner、generation、租约和暂停标记。

成功回执不属于可撤销内容。撤销或重做生成递增的新 revision，但保留以前的 `store_operations`。同一 operation 和相同 payloadHash 的重放返回原成功版本；把同一 ID 用于不同参数会被拒绝。调用方必须保留原 operationId，并明确提供当前 expectedRevision；新建调用使用 `expectedRevision:null`。旧的缺失元数据调用不会被默认为合法写入。

多个进程可以并行读取、准备候选和执行任务；SQLite 仅在短提交期间协调写入。两个进程从同一 revision 提交不同变更时，只有一个成功，另一方收到冲突并重新读取、合并或重新规划。不能把冲突后重试改成无条件覆盖。

同一工程数据库还承载运行时的 `agent_sessions`、`agent_tasks`、`agent_grants`、`agent_budget`、`agent_operations`、`agent_candidates`、`agent_validations`、`agent_events`、`session_activity`，以及工作流/媒体的 `service_records`。这些记录分别保存真实身份、授权代次、预算、调用对账、候选和验证状态。工程库索引位于工程根目录之外的 `.studio/registry.sqlite`；没有工程的大厅任务使用应用数据目录下的 `agent-state.sqlite`。它们不能作为工程内容的 HEAD 使用。

## 中断后继续

| 中断位置 | 恢复行为 |
| --- | --- |
| 首个 HEAD 提交前 | 复用创建 operationId 和 payloadHash。旧执行者停止续期、30 秒租约到期后，新进程可接管同一 `store_creation`；有效租约期间返回 `CREATE_IN_PROGRESS`，不抢占在工作的创建者。 |
| 素材准备中 | 先写入并同步临时文件，再用硬链接发布不可变目标。恢复时校验已有目标摘要；相同内容复用，不同内容报错，不覆盖。 |
| 版本文件已写好、HEAD 尚未提交 | 文件可能保留，但不在数据库索引中的文件不算已提交版本。旧 HEAD 仍有效。 |
| HEAD 已提交、回执未收到 | 用原 operationId 查询或重放，返回原成功版本，不再增加 revision。 |
| HEAD 已提交、兼容投影未完成 | 重新打开工程，从数据库指定的快照修复投影。 |
| 创建旧执行者恢复运行 | 创建 owner/generation/期限与首个 HEAD 在同一事务检查；过期旧执行者不能晚交覆盖接管者。 |
| 任务暂停、取消或租约被接管 | 旧 generation 不能完成受保护的主版本提交。外部模型调用若结果未知，保留调用记录并先对账，不能把本地恢复当作重新付费请求的许可。 |

受管新建工程按 `project.id` 选择固定目录，因此改变标题不会绕开首次创建意图。进程异常退出后无需手工删除工程目录；应使用原请求继续。正常失败会释放自己持有的创建租约，其他执行者持有的租约不会被释放。

新版不会递归清空 `.studio/staging`，因为其中可能有另一进程正在准备的版本。失败或崩溃留下的未引用文件不影响 HEAD；本次没有加入自动回收这些文件的功能。

## 文件系统与运行要求

并发支持范围是**同一台机器上的本地文件系统**，要求文件锁、原子重命名、文件同步和常规硬链接可用。没有把网盘同步目录、共享网络文件系统或多台机器同时写一个工程列入支持范围。工程分享使用导出的 `.yingliu` 工程包。

应用采用 Node 内置 `node:sqlite`，没有新增原生 npm 数据库依赖。`DatabaseSync` 只在独立 worker 中使用；等待 SQLite 锁不会阻塞应用主事件循环。每个连接固定配置：

```text
journal_mode=DELETE
synchronous=FULL
foreign_keys=ON
busy_timeout=5000
```

最低运行版本是 Node 22.18。保留 DELETE 日志模式以覆盖其内置 SQLite 版本，不启用 WAL；这也避免依赖旧 SQLite 中受影响的 WAL 重置路径。事务等待超过五秒会明确失败，不会把第二个应用进程当成非法进程拒绝启动。

构建时将纯 JavaScript worker 复制到 `dist/agent/sqlite-worker.mjs`。源码运行、Web 服务 ESM 包和 Electron 主进程 CJS 包分别解析这一文件；portable 包复制整个 `dist`。缺少 worker 时明确报告 `DATABASE_WORKER_MISSING`。

## 分享与验证边界

工程包导出当前权威工程快照、镜头源码和引用的媒体，导入后创建新的工程身份。包不复制 `.studio/state.sqlite`、运行时租约、授权、操作账本或供应商凭据；它不是执行会话迁移工具。完整目录备份用于本机状态恢复时应在所有写入进程退出后制作。

本次存储专项已使用 Node 22.18 实际运行 worker 的事务回滚、双连接写入和主事件循环响应测试；实际子进程测试覆盖同 revision 竞争、同 operation 并发、撤销后回放和租约栅栏。新增创建测试会终止尚未发布 HEAD 的子进程，并在测试数据库中推进其租约到期，验证接管恢复和旧执行者晚交拒绝。它没有以模拟等待声称真实运行了三十秒。

Linux x64 的 Electron 44.5.1 portable 包已在移出源码目录后，实际启动包内 SQLite worker、提交事务并检查 DELETE 模式；`--layout-only` 验收也执行了工程创建及导出恢复。该命令明确跳过桌面 GUI。以上记录不代表 Windows/macOS 原生桌面、真实模型生成或真实计费供应商验收。
