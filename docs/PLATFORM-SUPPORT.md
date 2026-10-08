# 映流 Studio 操作系统适配进度

更新日期：2026-10-08（Asia/Shanghai）。当前版本 0.2.0。Windows/macOS/Linux 的基础平台代码已实现；目标系统的原生窗口、系统钥匙环和安装验收需分别完成。

[首轮环境基线](platform-baseline.json)保留适配前结果；本轮实现与验证见 [platform-adaptation.json](platform-adaptation.json)。已有 macOS arm64 验收见 [ACCEPTANCE.md](ACCEPTANCE.md)，不能替代本轮改动的 macOS 回归。

本轮 Linux 类型检查、构建和 121 项测试全部通过。Linux 包迁移验证 6 项通过、GUI 检查跳过；可携带压缩包位于 `artifacts/yingliu-studio-linux-x64.tar.gz`，已逐文件核对包内容与相对链接。

## 平台状态

| 目标 | 当前进度 | 未完成验收 |
| --- | --- | --- |
| macOS arm64 | 已有原生与临时签名 `.app` 验收；本轮保留 `.app` 打包、系统语音与钥匙环分支 | 本轮原生回归、另一台机器、Developer ID 与公证 |
| macOS x64 | 平台实现与本机打包入口已准备 | Intel Mac 原生、媒体和包迁移 |
| Windows 11 x64 | 存储兼容、便携路径、Chrome/Chromium/Edge 搜索、凭据策略与 portable 目录打包已实现；平台差异由注入测试覆盖 | 真机保存恢复、DPAPI、桌面启动、媒体与发行包 |
| Ubuntu 24.04 LTS / Debian 13 x64 | 当前 Debian 13.6 云环境可运行后端、浏览器与实际媒体；Linux portable 包已实际构建和迁移验证 | 有显示会话的 Electron、libsecret/KWallet、桌面安装与播放 |

三系统 CI 已配置于 `.github/workflows/platform-checks.yml`，本轮未在远端执行，不作为矩阵通过证据。脚本仅使用当前宿主平台和架构的 Electron，不把 Linux 产物称为 Windows/macOS 包。arm64/x64 各有运行入口，只有实际运行过的目标才有验收结论。

## 已实现的基础适配

| 项目 | 入口 | 行为与验证边界 |
| --- | --- | --- |
| 原子持久化 | `src/host/directory-sync.ts`、`src/host/store.ts` | 同时处理目录打开与同步的可选能力；真实文件写入、fsync、rename 与 I/O 错误继续传播；Windows errno 与提交恢复在 Linux 注入验证 |
| 工程路径 | `src/core/project-paths.ts`、`src/core/index.ts`、`src/host/store.ts` | 新写入拒绝保留名、ADS、非法字符、尾点/空格、大小写/Unicode别名与嵌套冲突；多个资产可精确共享同一媒体文件 |
| 工具发现 | `src/host/tool-environment.ts`、`renderer.ts`、`audio.ts` | 按宿主搜索浏览器和 FFmpeg/ffprobe；统一 PATH、Windows 环境变量和 `.exe`；检查文件及执行权限，错误用户路径保留供修正 |
| 配音能力 | `src/shared/tts-capability.ts`、`src/client/AudioPanel.tsx` | 只在实际具备 macOS `say` 时默认本机配音；其他平台提示导入音频或配置语音接口；无效服务不能启用 |
| 凭据保护 | `src/desktop/native-secrets.ts`、`src/app/secrets.ts` | Linux 拒绝 `basic_text`、unknown 和不可用后端保存/解密；已有密文保留，手工制作和定向清除仍可用；配置失败恢复原密文字节 |
| 凭据界面 | `ProviderDialog.tsx`、`AudioPanel.tsx` | 展示安全存储错误和已有不可读钥匙；禁止新增弱保护钥匙，保留清除按钮与非密钥设置保存 |
| 验收标记 | `scripts/verify-app.ts` | 记录实际 OS、架构、Electron 与凭据后端；失败也写报告，移除固定 macOS 标签 |
| 发行入口 | `scripts/package-app.mjs`、`package-layout.mjs`、`verify-package.mjs` | 三平台 portable 布局、相对软链接、依赖与许可；迁移到源码目录外验证，桌面检查独立记录 |

旧 Unix 工程的只读快照和历史版本保留。便携性问题在核心校验中给出 warnings；新提交需修正不便携路径。物理源码访问、投影和迁移前拒绝冲突，Windows 拒绝无法表示的旧名字。不会自动改名或覆盖原工程。

## 开发与打包

当前云环境已安装 Node 24.19.0、npm 11.9.0、Chromium 151、FFmpeg/ffprobe 7.1.5 和 Electron 44.5.1，无需重新安装依赖。没有 DISPLAY/WAYLAND_DISPLAY。

在仓库执行：

```sh
npm run typecheck
npm test
npm run build
npm run package:app
node scripts/verify-package.mjs --layout-only
```

测试和包验证需要本地 socket/进程通信权限。本轮使用命令级网络运行权限；没有修改断言以绕过沙箱，也没有调用真实计费供应商。

`npm run package:app` 输出当前宿主对应目录：

| 系统 | 产物 | 启动 |
| --- | --- | --- |
| macOS | `artifacts/映流 Studio.app` | 打开 `.app` |
| Windows | `artifacts/yingliu-studio-win32-x64`（或 arm64） | `yingliu-studio.exe` |
| Linux | `artifacts/yingliu-studio-linux-x64`（或 arm64） | `yingliu-studio.sh` |

Linux 用户可主动运行包内的 `install-desktop-entry.sh` 安装菜单入口；移动目录后重新运行。打包和验证不会改写用户日常桌面菜单。安装包仍依赖外部 Chrome/Chromium 和 FFmpeg/ffprobe，没有云渲染。

`--layout-only` 实际检查包结构、宿主 Electron、相对链接、许可证、包外依赖、服务及备份恢复。未运行 GUI 时总体结果为 PARTIAL，桌面启动、系统凭据和原生媒体播放分别标记未验证。完整 `npm run verify` 与包 GUI 检查需目标系统的显示会话。

## 剩余验收

1. 在 Windows、macOS 两架构与 Linux 目标桌面实际执行三阶段基础检查，保存环境、版本和结果。
2. 验证首次启动、单实例、关闭前保存、任务取消、重启恢复、原生对话框与进程清理。
3. 验证 Windows DPAPI、macOS Keychain、Linux libsecret/KWallet，以及锁定、缺失、不可解密和删除场景。
4. 在实际浏览器/编码器下检查中文空格路径、真实捕帧、带音轨 MP4、ffprobe、完整解码与原生播放。
5. 在干净机器验证 portable 包、签名、系统提示、菜单入口和移除行为，再更新支持声明。

Windows 本地文件符号链接测试缺少权限时明确跳过并记录未验收，不代替安全断言通过；Windows CI 先启用 Developer Mode 并验证实际文件 symlink，权限不足即失败。真实模型质量、远程语音质量、完整人工观看听音和公开发行均不由本轮证明。
