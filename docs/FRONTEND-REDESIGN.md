# 映流 Studio 工作台前端交互与主题说明

本文档说明 `yingliu-studio` 对齐基线 `1.0.0` 后的工作台视觉、主题及交互契约。

## 1. 主题与布局

- **双色主题**：默认深色主题 + `[data-scheme=light]` Marble White 浅色工作台；顶部 `更多操作 → 切换到浅色工作台 / 切换到深色工作台` 可随时切换，结果持久化于 `localStorage['yingliu-workbench-scheme']` 并在应用初始化时读取。
- **自适应断点**：工作台随自身容器宽度在 `wide` / `medium` / `narrow` 间切换，抽屉面板、画布缩略导航与分栏视图保持一致可达。

## 2. 编辑保真与 1.2 秒后台防抖自动预览

- **防抖自动预览（`StudioController.refreshPreview()`）**：工作台自动保存时先提交工程版本，监视器保留上一版画面和混音。分镜主链完整、无保存冲突及源码草稿时，约 1.2 秒后在宿主命令队列后台准备最新版预览，画布缩略图也随之更新。准备期间用 `state.previewing` 驱动步骤条与监视器同步指示，右侧属性输入可继续编辑。
- **源码草稿与撤销保护**：`SourceEditor` 按工程与镜头持久化源码草稿（`localStorage['yingliu-studio.source-drafts.v1']`），未保存草稿阻止误导出或丢失导航；删除镜头提供撤销 Toast 并等待隔离保存完成后调用工程历史 `undo`。

## 3. 回归验证

- `tests/studio-interaction.test.ts` 通过 `esbuild` 与真实 Chromium 验证：分镜重新生成二次确认、删除镜头即时撤销、资产删除二次确认、菜单打开抽屉并聚焦标签、浅色/深色主题切换、空格播放与时间线指针联动、以及 1.2 秒防抖后台自动刷新预览。
