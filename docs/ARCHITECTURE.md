# 映流独立桌面 demo 架构

本目录是从现有视频插件提取的独立应用代码。桌面壳、应用模型配置、对话、项目后端和工程编辑器在本应用内协作，不依赖 DSH Session、连接服务、插件装载器或凭据。正式能力是否通过应以本目录的验证记录为准；原插件的历史验收不能替代独立应用验收。

## 当前 demo 的制作边界

用户可以让对话形成分镜和前端场景，也可以新建空白节点图，自行添加和连接镜头。对话提交与手工编辑都操作同一个稳定 project ID、shot ID 和 revision。节点图是镜头编排和素材绑定；主链采用线性播放顺序，不是任意推理节点执行器。

每个镜头是 HTML/CSS/ES module 场景。可视属性编辑已有的文字、图片、时长、运动和颜色参数；任意场景代码的细节继续由源码编辑或模型修改。没有从任意 JavaScript 自动反解图层、完整关键帧时间线、视频输入、多人协作或云渲染。

模型通道在当前 demo 中明确为 **text-only**。传给模型的是用户文字、素材名称与说明、尺寸与稳定资产 ID 等元数据；图片像素留在本机，不能据此宣称模型已经理解图片。实际场景运行器仍可使用绑定的本地图片。`AppSceneGenerator` 在每次请求中明确写入这一输入边界；它不使用 DSH 的附件或 `saveImage` 服务。未来接入视觉模型时，需另加有能力判断和用户可见发送范围的受控图片传输。

离线演示模型与真实供应商属于不同验证层。离线响应可以验证调用、编辑和制作链路；真实模型配置、可用性、付费请求及创作质量只在对应真实检查执行后成立。本次后端单元测试不调用任何真实 API。

## 模块及调用链

| 模块 | 当前职责 |
|---|---|
| `src/app/backend.ts` | `AppBackend` 实现 `BackendPort`，将 desktop 和对话请求转到同一工程后端；注入 ProviderHost、SecretStore 和 native reveal |
| `src/app/contracts.ts` | 应用模型、凭据、对话和后端的类型化端口 |
| `src/host/project-hub.ts` | 多工程索引、选中工程与定位；每个工程持有独立 StudioService，切换页面不会改变其他工程的后台任务 |
| `src/host/service.ts` | 统一请求处理、提交队列、版本检查、配音和生成协调、持久任务开始/结束记录 |
| `src/host/store.ts` | 项目内安全路径、图文/音频导入、项目 JSON 原子单文件保存、源码与 last-good 备份 |
| `src/core/` 和 `src/shared/types.ts` | 稳定业务 ID、镜头顺序、图校验、整数帧、有理数 FPS、参数和声音片段 |
| `src/client/` | React 工程 UI、LiteGraph 画布、共享工程状态、实际帧预览与声音属性 |
| `src/host/generator.ts` | text-only 结构化分镜/场景请求、模型 JSON 解析、参数与素材引用规范化 |
| `src/runtime/browser.ts` | `ready/renderFrame` 的无特权浏览器帧契约，按帧运行 HTML/DOM/Canvas 场景 |
| `src/host/renderer.ts` 和 `src/host/audio.ts` | 本机 Playwright 捕帧、混音、FFmpeg 编码、媒体回读与导出快照 |

核心调用顺序为：用户或对话 → BackendPort → ProjectHub → 工程 StudioService 队列 → 验证与写入 → 返回最新 snapshot。渲染与配音任务先记录为 running，再异步执行；最终产物提交回同一个工程队列。取消直接通知任务的 AbortController，不必等待长写操作排队。

`AppBackend({dataDirectory,providers,credentials,reveal})` 默认把工程放在 `dataDirectory/projects/`。工程内保存 `project.json`、`assets/`、`shots/`、`exports/`、实际检查产物和 `.studio/tasks/`。应用工程索引 `registry.json`、最近项目、执行文件路径和不含 Key 的 TTS 配置位于这个项目基目录。TTS Key 只使用注入的 SecretStore，引用为 `YINGLIU_TTS_API_KEY`；snapshot 只返回是否配置。

## 提交队列与版本冲突

同一个工程的 API 请求以及后台任务的内容提交共用串行队列。`save`、`apply`、`saveSource`、`restoreSource` 必须传 `expectedRevision`，并在队列内实际开始提交时比较当前版本。过期操作返回 `REVISION_CONFLICT`，没有版本返回 `REVISION_REQUIRED`；调用者读取最新工程，合并后再提交。

`import`、`audio`、`generate`、`preview` 和 `export` 传入版本时也校验；不传版本的素材追加基于队列当时的当前工程。`save` 不接受客户端任意提高 revision，保存版本使用当前版本加一。`apply` 整次修改产生一个新版本，保持模型局部修改时的镜头 ID。后台模型修改、配音与输出记录也回到队列提交，revision 不回退。

例如：

```ts
const snapshot = await backend.call('current', { projectId });
await backend.call('apply', {
  projectId,
  expectedRevision: snapshot.project.revision,
  shotPatches: [{ id: shotId, patch: { action: '缓慢推近' } }],
});
```

以上提供最小 CAS 和单工程串行化。它不能代替整工程多文件事务；多窗口、多个独立后端进程同时打开同一目录的跨进程锁也未实现。独立应用应只持有一个工程服务所有者。

## 任务记录与恢复

任务在开始实际工作之前原子写入 `.studio/tasks/<id>.json`，结束时记录 complete、failed 或 cancelled。重新打开项目会读取日志；发现上次仍为 running 的记录时，明确保存为 failed，并返回 `TASK_INTERRUPTED` 与“上次任务已中断”的提示。用户可以读取当前工程再重新执行。

这个恢复是 **中断识别与重试入口**，没有逐帧断点续渲、任务阶段 checkpoint 或自动重放。开始/结束日志不等于完整持久队列，也不承诺应用关闭后任务继续运行。任务取消与 dispose 只清理本应用创建的浏览器、编码或音频进程。

## 复用与尚缺的工程能力

稳定项目数据、图适配器、默认场景、帧运行器、源码检查、声音计划、输入快照、编码和媒体回读来自此前已实现模块。独立应用新增宿主端口、工程队列、CAS 和最小任务 journal。工作包里的生产知识与其他渲染引擎仍需要专门适配；不能把风格文档当成已经内置的场景运行器。

`packs/foundation/` 保留 foundation 的六份美术 recipe、横屏/竖屏输出 profile 与制作模板，是本仓库自己的数据，不依赖父目录。`packs.list` 目录接口返回六份 recipe 的名称、说明、配色和 `design_proposal` 状态，以及两份 profile。它们可以供导演对话参考，但没有因此变成六个现成效果运行器。下一步将 recipe/profile 与可选择的导演 preset 对接：简报保存选择及包版本，模型读取其构图与运动约束，实际场景产生后再逐项验证美术效果。

目前源码文件逐个原子替换，批量源码加 project.json 还不是一个原子提交。中途文件错误可能留下部分源码更新，模型分镜/逐镜生成也不是完整可回滚提案事务。后续需增加 staging、内容 hash、提交清单和 commit marker，让工程指针一次切换到新版本。

编辑器的撤销主要是内存中的工程快照，源码另有 previous 和 last-good。它不是跨源码、素材、音频、模型变更的持久统一撤销。后续应使用持久 command history 和版本化源码/资产引用，形成整次变更的恢复与撤销。

渲染仍需要本机 Chrome/Chromium、FFmpeg 与 ffprobe。发行包应管理固定版本与资源路径，并做新机器实际安装、捕帧、编码、播放器和字体检查。当前本机工具模式不能证明新机器已无需配置即可运行。

后续桌面执行可将受信任的工程服务与任务协调迁入 utility worker/utilityProcess，改善应用响应和崩溃影响范围。这个 worker 不是不可信代码沙箱。模型场景必须始终运行在与可信 UI 分离、无 Node/IPC/凭据/任意文件能力的浏览器上下文；媒体可见目录也要限制为场景所需的产物与素材。

## 后端测试的证据范围

`tests/backend.test.ts` 使用真实临时目录、真实项目文件与凭据接口替身，并明确 stub 浏览器预览/检查。它验证空白图、版本冲突、同 revision 并发提交、源码过期拒绝、多工程隔离和重开、任务日志开始落盘、中断识别、取消和 TTS Key 不进入项目/配置。

`node --import tsx --test tests/backend.test.ts` 不需要浏览器、loopback 或真实供应商。此测试通过只能说明这些后端行为；实际 UI、模型工具循环、场景隔离、真实捕帧、混音、导出、完整媒体解码和 native 播放需要各自的运行证据。
