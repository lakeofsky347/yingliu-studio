# 映流 Studio

一个从现有视频插件与制作工作包提取出的**独立桌面应用 demo**。用对话建立视频初稿，再通过节点图、镜头属性、场景源码与音轨继续打磨，最后本地导出 MP4。

本仓库拥有自己的 React 界面、Electron 窗口、模型配置、对话历史与工程目录。运行不需要 DeepSeek Harness，也不需要父工作区的文件。

## 开始体验

本地生成的 `artifacts/映流 Studio Demo.app` 可直接打开。源码运行需要 Node.js ≥ 22.18：

```sh
npm ci
npm start
```

浏览器开发入口：`npm run dev`，默认 `http://127.0.0.1:19430`。浏览器模式 API Key 只保存于进程内存；桌面模式通过 Electron safeStorage 使用操作系统安全存储加密。

预览检查和视频导出需要本机 Chrome/Chromium、FFmpeg、ffprobe。应用的「运行环境」可查看自动检测结果或填写工具绝对路径。应用包已包含 Electron、编辑器与浏览器驱动，尚未捆绑逐帧捕获所用 Chrome 和编码工具。

## 体验路径

1. 默认「离线演示 · 未调用模型」，输入“做一个关于海边散步的短片”。离线导演按固定规则生成三个包含可编辑代码的镜头。
2. 在分镜图或镜头条选择第二镜，更改标题、文字、背景和时长。拖动节点、连线或拖动镜头条调整分镜。
3. 继续输入“第二镜改为缩放，背景改成 #183c66”。只修改对应镜头，保留手改标题与稳定镜头 ID。
4. 查看影片预览，导入图片/文字/音频，安排音轨；需要更细的控制时编辑 HTML/CSS/JS。
5. 导出视频。输出保留工程快照、输入哈希、渲染与媒体检查报告。

也可点击「空白工程」，从镜头节点和视频输出节点自行搭建故事，然后继续对话。

## 配置真实模型

打开「模型设置」→「DeepSeek / 自定义」，填写 Base URL、模型 ID 和自己提供的 API Key。默认 `https://api.deepseek.com/v1` / `deepseek-chat`，支持 OpenAI 兼容的 `/chat/completions` 接口及 SSE。保存后密钥输入框清空，界面仅回报是否配置。

连接检查只请求模型目录。实际创作在发送指令后进行；当前验收没有请求真实供应商，也没有使用真实密钥。此 demo 仅发送文本及素材元数据，图片像素尚未传入模型。

## 当前能力与后续改造

已实现：独立桌面入口、多轮对话与有限导演工具循环、同一工程的节点/对话编辑、版本冲突拒绝、多工程持久化、任务开始/结束记录和中断恢复、实际逐帧预览、图片/文字/音轨、可编辑场景源码、本地 MP4 与检查回执。

内置 `packs/foundation` 的六种美术配方与两份交付 profile 作为导演参考；美术配方保留 `design_proposal`，还没有六套完整渲染风格。当前离线示例实际实现的是三段 DOM/Canvas 场景。

下一阶段：真实 DeepSeek 对话样片验收；场景独立 webContents 与资源 watchdog；工程+源码跨文件事务和持久化撤销；工作包预设选择与迁移；打包 Chrome/FFmpeg 或首次启动依赖安装；签名、公证与 Windows/Linux 打包。没有加入云渲染、视频上传、多人协作或节点市场。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
npm run verify
npm run package:demo
```

`verify` 启动本仓库自己的 Electron 窗口，在隔离测试目录中实际创作、手改标题、对话修改、捕获画面、导出带合成测试音的六秒视频、完整解码、桌面播放与重启回读。合成音只用于验证音轨，不代表 TTS 质量。报告与截图在 `artifacts/acceptance/`，测试工程在 `.local/`；这些路径不提交远端。

架构和下一步迁移：[ARCHITECTURE.md](docs/ARCHITECTURE.md)。模型接入与导演协议：[MODEL-PROTOCOL.md](docs/MODEL-PROTOCOL.md)。验证结果：[ACCEPTANCE.md](docs/ACCEPTANCE.md)。来源与许可：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
