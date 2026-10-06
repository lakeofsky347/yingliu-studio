# 映流 Studio 0.2 架构

应用把项目首页、对话导演、工程编辑与本地制作接成持续可用的工作流。所有应用代码、数据包、依赖和打包入口在本目录，运行不依赖 DSH 的会话、插件装载器或凭据。

## 应用边界与模块

| 模块 | 职责 |
| --- | --- |
| `src/desktop/` | 单实例 Electron 壳、无 Node 的编辑器、主窗口 IPC 校验、系统加密凭据、文件选择与关闭前保存 |
| `src/app/application.ts` | 白名单应用路由、运行环境健康、模型配置、会话与工程备份；关闭时停止模型并排空已有调用 |
| `src/app/model.ts` | 独立配置、兼容 JSON/SSE 模型协议、超时/输出界限、Key 脱敏；fixture 只供测试显式注入 |
| `src/app/conversation.ts` | 持久 turn 状态、上下文预算、读取回执、有限修复、候选工程校验与一次事务提交 |
| `src/app/archive.ts` | `.yingliu` ZIP 备份、SHA256 清单、路径与真实解压量验证、新 ID 原子导入 |
| `src/host/project-hub.ts` | 多工程注册、选择、重命名、复制、归档及恢复；每工程独立服务 |
| `src/host/service.ts` | 工程队列、CAS、渲染/声音协调、持久任务记录、取消与白名单重试 |
| `src/host/store.ts` | 安全路径、不可变完整版本、原子 head、单调 revision、修复投影、持久 Undo/Redo、素材导入 |
| `src/core/`、`src/shared/` | 稳定业务 ID、整数帧与有理数 FPS、镜头图、参数、资产和声音片段 |
| `src/client/` | 首页与简报、统一创作对话、LiteGraph、源码/素材/音轨、任务/历史/导出、超时恢复 |
| `src/runtime/`、`src/host/renderer.ts` | 按帧场景契约、软件 Canvas 可复现捕帧、本地浏览器、FFmpeg/ffprobe 与实际媒体 QA |

镜头由 HTML/CSS/ES module 构成，按 `render(ctx)` 独立求值。节点图表达线性播放主链、镜头及素材绑定；不是任意模型工作流执行器。可视属性与模型共用稳定 shot ID；不会从任意 JS 自动反解完整图层或关键帧时间线。

## 完整版本与提交点

工程保存到应用 `dataDirectory/projects/`；外部目录打开也使用相同存储协议。`.studio/versions/<id>.json` 保存工程与所有镜头源码的完整不可变版本，`.studio/revisions/<revision>.json` 将单调业务版本定位到快照。`.studio/state.json` 保存当前版本以及 Undo/Redo 指针。

提交先验证项目、全部 source 和素材引用，再写快照与版本索引，最后原子切换状态指针。指针 rename 是整次工程+源码修改的提交点。`project.json` 与 `shots/` 中的 HTML/CSS/JS 是当前版本投影；提交后投影失败时，重新打开从 head 修复，不将半组投影当作工程事实。临时文件和目录使用同步写入，但没有机器断电注入测试。

同工程 API 和后台任务提交共用串行队列。save/apply/saveSource/restoreSource/undo/redo 必须提供 expectedRevision，在实际写入前检查；冲突不会覆盖已保存用户内容。素材追加可基于队列当时版本。Undo/Redo 将以前内容提交为新的 revision，版本号不回退；源码、音轨、素材引用和模型修改一起恢复，同一生成任务可归为一个撤销步骤。

素材文件由 UUID 命名并视为不可变，历史恢复其引用，不删除旧素材。还未提供快照/素材垃圾回收、跨进程锁或多窗口写入。原生应用通过单实例和一个服务所有者维持此范围。

导出先冻结 project revision，并按该 revision 读取整组源码与素材，复制到独立快照再渲染；后续工程修改不会让导出混用新源码。结果记录输入版本、哈希、帧数、音视频规格和检查报告。每次导出产生新目录，旧成片可以继续播放。

## 对话与任务生命周期

模型设置默认 custom；用户在应用配置自己的 Key。讨论仅持久对话，不创建或修改工程。创建向导先保存用户简报；模型修改先形成完整候选工程，校验所有动作后用一次 create/apply 提交。

计划格式、工具校验和已知版本冲突可以在最多四轮内通过实际读取回执修复。未知 I/O 或无法判断是否提交的失败不自动重投事务。预览失败保留已提交版本和失败 turn，用户可以修复、撤销或重试。对话包含 pending/succeeded/failed/cancelled/interrupted 状态；重启会识别 pending 中断，重试引用原请求，不被当前界面的图像选择覆盖。

制作任务在执行前写入 `.studio/tasks/<id>.json`，结束记录 complete/failed/cancelled。应用重启把仍运行的记录恢复为明确失败的 TASK_INTERRUPTED；只重放经过白名单校验的自身任务参数，凭据不进入记录。重试基于当前工程，并验证当前 revision。配音等真实计费操作不会由任务恢复自动重放。

关闭前编辑器尝试保存本地草稿，未保存源码或保存失败可保留窗口。还有模型/制作任务时用户选择继续制作或取消并退出；dispose 等待取消记录和已开始请求完成，并清理本应用的渲染浏览器、编码与音频子进程。没有退出后后台工作或逐帧断点续渲。

## 场景执行与凭据边界

编辑器使用随机端口的 `127.0.0.1` origin，HTTP 写 API 要求随机 token 和相同 origin；桌面 IPC 只接受该窗口的主 frame、匹配 frameTreeNodeId 与白名单方法。编辑器 contextIsolation/sandbox 开启，Node 关闭。

画面服务使用 `localhost` origin。Electron 强制 site-per-process，使模型场景与编辑器处于不同系统 renderer 进程；实际验收还检查二者 PID 不同。画面没有 preload bridge、Node 或 IPC，网络由 CSP 限制，资源服务只开放 runtime、媒体素材、检查图与成片，拒绝 project、凭据和日志。子 frame 导航和新窗口受控。

主画面与缩略帧以 ready/frame 回执和十秒 watchdog 判断无响应，后续 render 请求不能不断延迟这个界限。原生 resetScene 仅处理当前编辑窗口关联的 localhost child frame，排除 editor PID，再通过限定的 Chrome 调试协议中止对应 iframe target 的 JavaScript，并临时导航到空白页；重载采用最新已保存源码，可恢复无限循环场景，编辑器保留。没有宣称 CPU/内存配额、任意恶意代码完全隔离或通用执行资源沙箱。

桌面 Key 用 safeStorage 加密持久化，设置文件仅含配置与 hasKey 状态；模型响应和错误脱敏。图片默认只有元信息；需要模型能力、全局图片启用、本轮图片 IDs 和明确上传授权同时满足，且验证工程路径、尺寸、类型与字节限制。

## 工作包与可移植性

`packs/foundation` 是本应用自己的六份 recipe、两份交付 profile 和制作模板；manifest 保留来源哈希。简报保存选择与版本，导演读取实际 recipe 内容作为创作约束；recipe 仍为 design_proposal，需对生成画面另行验证。

macOS 包包含 Electron、应用、fflate 与 playwright-core；Chrome/Chromium、FFmpeg、ffprobe 和系统字体通过本机检测或用户指定提供。源码和已打包应用的迁移验收与真实云供应商、跨机器安装、签名公证分别记录，不能互相替代。
