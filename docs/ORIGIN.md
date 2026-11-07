# 提取来源

这个仓库是用户授权在现有工作区中新建的独立 Git 工程，原插件和工作包没有在本次实现中被改写。

| 来源 | 本仓保留或改造 | 状态 |
| --- | --- | --- |
| dsh-video-studio 0.2.0 | project/spec、LiteGraph 适配器、属性/源码/音轨界面、DOM/Canvas 帧运行器、逐帧捕获、FFmpeg/ffprobe、资产与源历史 | 在本仓独立适配后重新运行验收 |
| frontend-video-foundation 0.1.0 | 六种 art recipe、两份 delivery profile、brief/storyboard/QA 模板；按帧的确定性与快照/哈希思路 | 数据复制，哈希在 packs/foundation/manifest.json；recipe 仍为 design_proposal |
| 独立应用新增 | Electron shell/preload、应用 HTTP 入口、ProviderManager、ConversationService、应用后端端口、CAS/串行提交、持久工程事务与历史、项目管理、任务恢复、工程备份、测试与打包 | 独立应用 0.2.0 |

不复制父仓的 films、私有素材、凭据、node_modules、原插件二进制或已有工程。npm 锁文件依赖均来自 registry，运行路径不引用父仓。

本仓库自有代码及用户自有工作包数据采用 GNU GPL 第 3 版，仅限第 3 版（SPDX：`GPL-3.0-only`），完整条款见根目录 `LICENSE`；版权与提取来源保留在 `NOTICE`。此前仓库采用的 Apache-2.0 许可全文保留在 `licenses/Legacy-Apache-2.0.txt`；原插件 0.2.0 提取代码及独立应用历史版本的 MIT 许可全文和两项版权声明继续保留在 `licenses/Legacy-MIT.txt`。第三方依赖继续适用各自的许可，见 `THIRD_PARTY_NOTICES.md`、`licenses/` 及随依赖分发的许可证和 notices；`packs/foundation` 的原始数据、来源哈希与 `design_proposal` 状态保持不变。


## 后续上游同步

2026-11-08 从原 `lakeofsky347/dsh-video-studio`（现名 `lakeofsky347/yingliu-video-studio`）的 `main` 适配最新可复用改动，固定来源为 `28a1953b8c12d922c31fba30b112554e49f6cd34`。两仓独立维护，无共同 Git 祖先，因此采用按功能迁移，保留独立应用的 Electron、模型与凭据、工程事务及打包架构。范围、差异和验证见 [上游同步记录](UPSTREAM-SYNC.md)。
