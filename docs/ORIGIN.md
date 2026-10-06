# 提取来源

这个仓库是用户授权在现有工作区中新建的独立 Git 工程，原插件和工作包没有在本次实现中被改写。

| 来源 | 本仓保留或改造 | 状态 |
| --- | --- | --- |
| dsh-video-studio 0.2.0 | project/spec、LiteGraph 适配器、属性/源码/音轨界面、DOM/Canvas 帧运行器、逐帧捕获、FFmpeg/ffprobe、资产与源历史 | 在本仓独立适配后重新运行验收 |
| frontend-video-foundation 0.1.0 | 六种 art recipe、两份 delivery profile、brief/storyboard/QA 模板；按帧的确定性与快照/哈希思路 | 数据复制，哈希在 packs/foundation/manifest.json；recipe 仍为 design_proposal |
| 独立应用新增 | Electron shell/preload、应用 HTTP 入口、ProviderManager、ConversationService、应用后端端口、CAS/串行提交、最小 journal、测试与打包 | 独立 demo 实现 |

不复制父仓的 films、私有素材、凭据、node_modules、原插件二进制或已有工程。npm 锁文件依赖均来自 registry，运行路径不引用父仓。原始许可保留在 LICENSE 和 THIRD_PARTY_NOTICES.md。
