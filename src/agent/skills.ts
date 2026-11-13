/** Self-written director guidance, loaded on demand with skill_read. Original text for 映流; not copied from any external framework docs. */
export const SKILLS: Record<string, { title: string; body: string }> = {
  'scene-structure': { title: '镜头源码结构', body: `每个镜头是一份 { html, css, js }。
- html：只写静态骨架，用 data-role 标记会被脚本改写的节点；根节点用绝对定位铺满（position:absolute; inset:0）。
- css：用 CSS 变量承载颜色、字号、位置，脚本只改变量，避免每帧重排大量样式。
- js：导出 ready(ctx)（可选，做一次性准备并校验节点存在）与 render(ctx)（每帧调用）。
- ctx 常用字段：root（DOM 根）、ctx2d（画布 2D 上下文，绘制在 DOM 之下）、params（镜头参数：text/subtitle/background/foreground/accent/fontSize/motion 等）、width/height、time（本镜头内秒数）、assets（已解码的图片等素材）、hasVideo（是否有视频底层）。
- 修改前先 shot_read_source，改完用 shot_write_source 提交（带 expectedRevision），再 render_check。` },
  'deterministic-motion': { title: '确定性动画与帧对齐', body: `渲染是逐帧截图，必须"同一时间点 → 同一画面"。
- 动画只依赖 ctx.time，不用 Date.now()、requestAnimationFrame、setTimeout、CSS transition/animation（它们按真实时间走，导出时会错位）。
- 随机数用以镜头 ID 为种子的伪随机（例如 mulberry32），不要用 Math.random()。
- 缓动：先把进度 clamp 到 0–1，再套 easeOutCubic 等函数；分段动画用 (time - start) / duration。
- 入场 0.3–0.6 秒，停留时间 ≥ 文字阅读时间（中文约 4–6 字/秒），出场前留 0.2 秒余量。` },
  'layout-safe-area': { title: '版式与安全区', body: `- 文字保持在四周 6%–8% 的安全区内；竖屏（高>宽）字幕放在底部 7%–12%，避开平台按钮区域。
- 字号按 min(width,height)/1080 缩放；标题不超过两行，正文每行 12–18 个汉字。
- 对比度：正文与背景亮度对比 ≥ 4.5:1；浅色背景用深色字，复杂图片上加半透明底板。
- 同一作品统一 2–3 种颜色和 1–2 种字体（遵守已批准计划中的 style）。` },
  'subtitles-voice': { title: '字幕与配音', body: `- 字幕写在 params.subtitle；超过两行就拆到下一个镜头或缩短文字。
- 有配音时先生成配音，再用 align_to_voice 让镜头时长贴合配音，最后检查字幕是否与配音同步。
- 没有配音模型时：把旁白写成字幕，节奏按每秒 4–6 个汉字估算镜头时长。` },
  'self-made-visuals': { title: '导演自制画面（未接入生成模型时）', body: `- 用 SVG/Canvas 画几何插画、图标、图表、粒子、渐变光斑；用 CSS 变量和 ctx.time 驱动视差、缩放、描边动画（stroke-dashoffset）。
- 角色可以用简化的扁平造型（头身比、发型轮廓、主色），保持和计划中角色特征一致：同一角色在每个镜头用同一组颜色和轮廓。
- 背景分 2–3 层（远景色块、中景形状、前景细节），用不同速度移动，制造景深。
- 避免外链资源（字体、图片 URL）；需要图片时用素材库已有素材。` },
  'performance-pitfalls': { title: '性能与常见错误', body: `- render 里不要创建大量 DOM；在 ready 中建好节点，render 只改属性。
- Canvas 每帧先 setTransform 重置再绘制，绘制结束 restore，避免状态累积。
- 常见报错：选择器找不到节点（ready 中检查）、未处理的图片未加载（只用 ctx.assets 里已解码的图片）、源码超过 2MB。
- 每次写入后 render_check；有视觉模型时再 visual_review。` },
  'consistency': { title: '角色与风格一致性', body: `- 先在 plan_story 里写清风格（look/palette/motion/negative）与角色的可见特征（发型、脸型、服装、主色、配饰），特征要具体到能画出来。
- 生成图片/视频时传 characterIds，系统会自动拼接一致性锚点；不要在提示词里改写角色外貌。
- 连续动作的相邻镜头：先 frame_handoff 取上一镜尾帧，再把它作为 generate_video 的首帧。
- 生成后用 consistency_review 打分；低分只提出重生建议，重生仍需用户批准。` },
};
export function skillIndex(): string { return Object.entries(SKILLS).map(([id, s]) => `${id}（${s.title}）`).join('、'); }
