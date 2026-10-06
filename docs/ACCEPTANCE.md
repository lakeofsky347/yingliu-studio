# 独立应用 demo 验收

验收日期：2026-10-06。范围：当前 macOS arm64 本机与独立仓库源码。真实供应商创作为 **NOT_CHECKED**；测试没有使用真实模型密钥或付费调用。

## 已执行

- TypeScript 严格类型检查通过，独立 build 通过。
- 20 项本地单元与 mock 回归全部通过。覆盖工程隔离、CAS 并发/过期拒绝、任务 journal/中断恢复、凭据隔离、模型 SSE/截断处理、多轮导演回执、手改标题保留、空工程复用、客户端并发保存与失败退出。
- 15 项真实 Electron 集成检查通过。包含桌面启动、受限 preload、界面对话创建三个带实际源码的镜头、属性自动保存、局部对话修改、实际 PNG 捕获、场景状态访问拒绝、编辑器 HTTP token 验证、iframe 无 Node/IPC、跨源读取拒绝、外网 fetch 被 CSP 拒绝、真实 MP4、桌面播放、系统加密凭据、重启和窄窗口。
- 实际视频为 640×360、24 fps、6 秒、144 帧，H.264 yuv420p + AAC 48 kHz 双声道。FFprobe 回读与 FFmpeg 完整解码通过；关键帧逆序 seek 和冷加载一致；播放器 currentTime 实际前进且无 media error。
- 密钥持久化用可识别的**合成测试字符串**，验证加密文件不含原文、重启后 `hasKey=true`，随后删除测试密钥。未读取或复用其它应用凭据。
- macOS `.app` 保留 Electron framework 的相对符号链接，复制到源仓库以外的临时目录后启动。八项应用包验收全部通过（含宽桌面画布首屏可见）。独立入口可新建空节点图、手工添加三镜、拖动镜头改变主链顺序、实际预览与界面源码保存。

原始细节和截图由运行脚本保存在本地 `artifacts/acceptance/verification.json`、`package-verification.json` 和 PNG。源码仓库不提交测试工程、密钥、缓存、大型应用二进制或渲染中间帧。

## 证据边界

单元测试中的 renderer stub 和 mock HTTP 只证明对应协议与状态行为。Electron 集成测试实际运行 Chrome/Canvas/FFmpeg，不证明真实模型输出质量。视频音轨来自合成音 fixture，用于验证音频路径，不代表真实 TTS 或人工听音验收。

当前没有向模型发送 PNG，不能把运行检查称为模型视觉检查。尚未完成完整人工观看/听音、真实 DeepSeek 首次接入、六种美术配方实现、另一台机器、Windows/Linux、签名公证和外部分发验收。

编辑器与场景不同源，场景无 Node 与桌面 bridge、受 CSP/网络限制。但嵌入 iframe 的无限循环资源消耗/崩溃隔离没有独立 watchdog 验收。桌面采用单实例锁，同一进程内串行工程写入；多个独立后台服务进程之间的工程锁仍需后续实现。

## 复验

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify
npm run package:demo
node scripts/verify-package.mjs
```

需要已安装可检测的 Chrome/Chromium、FFmpeg 和 ffprobe。脚本只关闭自己创建的窗口和渲染进程；每次使用新的隔离数据目录。
