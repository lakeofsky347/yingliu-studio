import { compileDirectorPlan } from '../app/conversation.ts';
import type { ChatInput } from '../app/contracts.ts';
import type { AgentTool, JsonSchema, ToolContext, ToolResult } from './tool-contracts.ts';
import { bound, summarizeProject } from './context.ts';
import { synthesize, type SynthSpec } from './synth.ts';
import type { Capabilities } from './tool-contracts.ts';
import type { VideoProject } from '../shared/types.ts';
import { anchorPrompt, dataChecks, frameIssue, normalizeCharacter, normalizeShots, normalizeStyle, pngLuma, type QcReport, type Story } from './story.ts';
import { SKILLS, skillIndex } from './skills.ts';

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string): JsonSchema => ({ type: 'string', description });
const int = (description: string): JsonSchema => ({ type: 'integer', description });
const json = (value: unknown) => bound(JSON.stringify(value));

function need(args: Record<string, unknown>, key: string): string { const value = args[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`参数 ${key} 必填`); return value; }
function revision(args: Record<string, unknown>): number { const value = args.expectedRevision; if (!Number.isSafeInteger(value)) throw new Error('参数 expectedRevision 必须是整数；先调用 project_get'); return value as number; }
async function rpc(ctx: ToolContext, endpoint: string, payload: Record<string, unknown>) {
  const callId = typeof payload.__callId === 'string' && payload.__callId ? payload.__callId : 'call';
  const operationId = typeof payload.operationId === 'string' ? payload.operationId : `${ctx.runId}.${endpoint}.${callId}`.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 200);
  const body: Record<string, unknown> = { projectId: ctx.projectId, ...payload, operationId };
  if (endpoint === 'media.generate' && typeof body.clientRequestId !== 'string') body.clientRequestId = operationId;
  const result = await ctx.port.route(endpoint, body);
  if (!result.ok) throw Object.assign(new Error(result.error?.message ?? '操作失败'), { code: result.error?.code });
  return result.value;
}
function agentInput(ctx: ToolContext, message: string): ChatInput { return { message, projectId: ctx.projectId, provider: 'agent', model: 'agent', intent: 'modify', sessionId: 'agent-tool', operationId: (ctx.runId.replace(/[^a-zA-Z0-9_.:-]/g, '') || 'agent-tool').slice(0, 128), expectedRevision: null }; }

/** Apply a director-protocol action (video_update / video_audio) through the same validator the chat path uses. */
async function directorAction(ctx: ToolContext, tool: 'video_update' | 'video_audio', args: Record<string, unknown>, structural: boolean, label: string): Promise<ToolResult> {
  const snapshot = await ctx.port.snapshot(ctx.projectId);
  const creating = !snapshot.project?.shots.length;
  const message = structural ? '按智能体计划添加、删除或重排镜头' : '按智能体计划修改';
  const plan = compileDirectorPlan({ intent: creating ? 'create' : 'modify', message: label, actions: [{ tool, arguments: args }] }, snapshot, agentInput(ctx, message), creating ? 'create' : 'modify');
  if (!plan.candidate || !plan.mutated) return { content: '计划没有产生修改。' };
  const sources = Object.fromEntries(plan.sources.map(item => [item.shotId, item.source]));
  const next = await ctx.port.commit(ctx.projectId, snapshot.project?.revision ?? 0, plan.candidate, sources, '智能体：' + label);
  return { content: json({ ok: true, revision: next.project?.revision, project: summarizeProject(next.project) }), revision: next.project?.revision };
}

const ids = (value: unknown) => Array.isArray(value) ? value.map(String).slice(0, 8) : [];
async function anchored(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const prompt = need(args, 'prompt'); const story = await ctx.docs.story();
  return (prompt + anchorPrompt(story.status === 'approved' || story.characters.length ? story : null, ids(args.characterIds))).slice(0, 4000);
}
function keyframes(project: VideoProject): { frame: number; shotId: string }[] {
  let start = 0; const frames: { frame: number; shotId: string }[] = [];
  for (const id of project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id)) { const shot = project.shots.find(s => s.id === id); if (!shot) continue; frames.push({ frame: start + Math.floor(shot.durationFrames / 2), shotId: id }); start += shot.durationFrames; }
  return frames;
}
/** Mutates project in place; returns a description of each change. */
export function alignToVoice(project: VideoProject, pad: number, wanted: Set<string> | null): { shotId: string; fromSeconds: number; toSeconds: number }[] {
  const fps = project.target.fps.num / project.target.fps.den; const changes: { shotId: string; fromSeconds: number; toSeconds: number }[] = [];
  for (const shot of project.shots) {
    if (wanted && !wanted.has(shot.id)) continue;
    const voices = (project.audioClips ?? []).filter(c => c.role === 'voice' && c.shotId === shot.id);
    let length = 0;
    for (const clip of voices) { const asset = project.assets.find(a => a.id === clip.assetId); if (!asset?.duration) continue; clip.startSeconds = 0; length = Math.max(length, Math.min(clip.trimEnd ?? asset.duration, asset.duration) - clip.trimStart); }
    if (!length) continue;
    const frames = Math.max(1, Math.ceil((length + pad) * fps)); if (frames === shot.durationFrames) continue;
    changes.push({ shotId: shot.id, fromSeconds: Math.round(shot.durationFrames / fps * 100) / 100, toSeconds: Math.round(frames / fps * 100) / 100 }); shot.durationFrames = frames;
  }
  if (changes.length) project.targetDuration = Math.round(project.shots.reduce((s, x) => s + x.durationFrames, 0) / fps * 100) / 100;
  return changes;
}
export async function qualityCheck(ctx: ToolContext): Promise<QcReport> {
  const project = (await ctx.port.snapshot(ctx.projectId)).project; if (!project) throw new Error('没有打开的工程');
  const story: Story = await ctx.docs.story();
  const issues = dataChecks(project, story); const unchecked: string[] = [];
  for (const f of keyframes(project).slice(0, 12)) {
    ctx.signal.throwIfAborted();
    try { const shot = await ctx.port.capture(ctx.projectId, f.frame, ctx.signal); const luma = shot.mime === 'image/png' ? pngLuma(shot.bytes) : null; if (!luma) { unchecked.push(`${f.shotId}：画面格式无法分析`); continue; } const issue = frameIssue(f.shotId, luma); if (issue) issues.push(issue); }
    catch (error) { if (ctx.signal.aborted) throw error; unchecked.push(`${f.shotId}：截帧失败（${error instanceof Error ? error.message : String(error)}）`); }
  }
  const report: QcReport = { pass: !issues.some(i => i.severity === 'high'), checkedAt: new Date().toISOString(), issues, unchecked };
  await ctx.docs.saveQc(report); return report;
}

export function createTools(): AgentTool[] {
  const tools: AgentTool[] = [
    { name: 'project_get', risk: 'read', description: '读取当前工程摘要：版本号、镜头、素材、输出规格。修改前先调用。', parameters: object({}),
      async run(_args, ctx) { const snapshot = await ctx.port.snapshot(ctx.projectId); return { content: json({ ...summarizeProject(snapshot.project), task: snapshot.task ? { kind: snapshot.task.kind, status: snapshot.task.status, message: snapshot.task.message } : null }), revision: snapshot.project?.revision }; } },
    { name: 'shot_read_source', risk: 'read', description: '读取一个镜头的 HTML/CSS/JS 源码。', parameters: object({ shotId: str('镜头 ID') }, ['shotId']),
      async run(args, ctx) { return { content: json(await ctx.port.readSource(ctx.projectId, need(args, 'shotId'))) }; } },
    { name: 'env_check', risk: 'read', description: '检查本机 Chrome/FFmpeg/ffprobe 是否可用（渲染和导出所需）。', parameters: object({}),
      async run(_args, ctx) { const { environment } = await ctx.port.snapshot(ctx.projectId); const e = environment as unknown as Record<string, unknown>; return { content: json({ browserAvailable: e.browserAvailable, ffmpegAvailable: e.ffmpegAvailable, ffprobeAvailable: e.ffprobeAvailable }) }; } },
    { name: 'task_status', risk: 'read', description: '查询媒体生成任务或协作流程的状态。', parameters: object({ kind: { type: 'string', enum: ['media', 'workflow'] }, id: str('任务 ID') }, ['kind', 'id']),
      async run(args, ctx) { const value = await rpc(ctx, args.kind === 'workflow' ? 'workflows.get' : 'media.get', args.kind === 'workflow' ? { workflowId: need(args, 'id') } : { taskId: need(args, 'id') }); return { content: json(value) }; } },
    { name: 'video_update', risk: 'write', description: '修改分镜：标题/主题/时长/输出规格、镜头参数（shotPatches）、添加/删除/重排镜头、替换镜头源码（sourcesByIndex 或 sources）。参数与导演协议 video_update 相同，必须带 expectedRevision。',
      parameters: object({ expectedRevision: int('当前工程版本'), update: { type: 'object', description: '导演协议 update 对象' }, structural: { type: 'boolean', description: '是否增删或重排镜头' }, label: str('本次修改的简短说明') }, ['expectedRevision', 'update']),
      async run(args, ctx) { revision(args); const { structural, label, ...rest } = args; return directorAction(ctx, 'video_update', rest, structural === true, typeof label === 'string' ? label : '修改分镜'); } },
    { name: 'shot_write_source', risk: 'write', description: '保存一个镜头的完整源码 {html,css,js}；保存后会执行场景检查。', parameters: object({ expectedRevision: int('当前工程版本'), shotId: str('镜头 ID'), source: object({ html: str('HTML'), css: str('CSS'), js: str('ES 模块，导出 render(ctx)') }, ['html', 'css', 'js']) }, ['expectedRevision', 'shotId', 'source']),
      async run(args, ctx) {
        const source = args.source as { html: string; css: string; js: string };
        if (!source || [source.html, source.css, source.js].some(part => typeof part !== 'string')) throw new Error('source 须包含 html/css/js 字符串');
        if (source.html.length + source.css.length + source.js.length > 2_000_000) throw new Error('单镜头源码超过 2MB 上限');
        const next = await ctx.port.saveSource(ctx.projectId, need(args, 'shotId'), revision(args), source);
        return { content: json({ ok: true, revision: next.project?.revision }), revision: next.project?.revision };
      } },
    { name: 'audio_edit', risk: 'write', description: '编辑音轨（导演协议 video_audio：添加/移除旁白、音乐、音效，增益与位置）。', parameters: object({ action: str('add/remove/update'), request: { type: 'object' } }, ['action']),
      async run(args, ctx) { return directorAction(ctx, 'video_audio', args, false, '编辑音轨'); } },
    { name: 'undo', risk: 'write', description: '撤销上一次工程修改。', parameters: object({}),
      async run(_args, ctx) { const snapshot = await ctx.port.snapshot(ctx.projectId); await rpc(ctx, 'undo', { expectedRevision: snapshot.project?.revision ?? 0 }); const next = await ctx.port.snapshot(ctx.projectId); return { content: json({ ok: true, revision: next.project?.revision }), revision: next.project?.revision }; } },
    { name: 'render_check', risk: 'read', description: '刷新预览并检查资源与关键帧，返回渲染错误。', parameters: object({}),
      async run(_args, ctx) {
        await rpc(ctx, 'preview', {});
        for (let i = 0; i < 240; i++) { ctx.signal.throwIfAborted(); const s = await ctx.port.snapshot(ctx.projectId); if (!s.task || s.task.kind !== 'preview' || s.task.status !== 'running') return { content: json({ status: s.task?.status ?? 'complete', message: s.task?.message, error: s.task?.error }) }; await new Promise(r => setTimeout(r, 250)); }
        return { content: json({ status: 'timeout', message: '预览检查超过 60 秒' }) };
      } },
    { name: 'capture_frame', risk: 'read', description: '截取指定帧的画面，用于你自己查看（需要视觉模型）。', parameters: object({ frame: int('帧序号，从 0 开始') }, ['frame']),
      async run(args, ctx) { const frame = Number(args.frame); if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('frame 无效'); const shot = await ctx.port.capture(ctx.projectId, frame, ctx.signal); return { content: json({ frame: shot.frame, shotId: shot.shotId }), images: [{ mime: shot.mime, bytes: shot.bytes }] }; } },
    { name: 'visual_review', risk: 'read', requires: ['vision'], description: '截取每个镜头的关键帧，交给视觉检查模型，返回结构化问题列表（镜头、帧、问题、严重度、建议）。修改后用它自检。', parameters: object({ shotIds: { type: 'array', items: { type: 'string' } } }),
      async run(args, ctx) {
        const snapshot = await ctx.port.snapshot(ctx.projectId), project = snapshot.project; if (!project) throw new Error('没有打开的工程');
        if (!ctx.port.vision) return { content: json({ skipped: true, reason: '未配置视觉检查模型（vision 角色）；请改用 render_check' }) };
        const wanted = Array.isArray(args.shotIds) ? new Set(args.shotIds.map(String)) : null;
        let start = 0; const frames: { frame: number; shotId: string }[] = [];
        for (const id of project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id)) { const shot = project.shots.find(s => s.id === id)!; if (!wanted || wanted.has(id)) frames.push({ frame: start + Math.floor(shot.durationFrames / 2), shotId: id }); start += shot.durationFrames; }
        const images = [] as { mime: string; bytes: Uint8Array }[];
        for (const item of frames.slice(0, 6)) { const shot = await ctx.port.capture(ctx.projectId, item.frame, ctx.signal); images.push({ mime: shot.mime, bytes: shot.bytes }); }
        const answer = await ctx.port.vision('逐张检查视频关键帧（顺序对应镜头 ' + frames.slice(0, 6).map(f => f.shotId).join(', ') + '）。只输出 JSON：{"pass":true|false,"issues":[{"shotId":"","problem":"","severity":"low|medium|high","suggestion":""}]}。检查文字溢出/遮挡、空白画面、对比度、元素越界、与镜头意图不符。', images, ctx.signal);
        return { content: bound(answer, 4000) };
      } },
    { name: 'generate_image', risk: 'cost', requires: ['image'], description: '用图片模型生成素材（产生费用，需要用户批准）。传 characterIds 时自动拼接计划中的风格与角色特征锚点。完成后用 media_apply 采用。', parameters: object({ expectedRevision: int('当前工程版本'), prompt: str('画面描述'), shotId: str('关联镜头'), characterIds: { type: 'array', items: { type: 'string' }, description: '出场角色 ID（来自创作计划）' } }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) { const task = await rpc(ctx, 'media.generate', { expectedRevision: revision(args), operation: 'text-to-image', prompt: await anchored(ctx, args), ...(args.shotId ? { shotId: args.shotId } : {}), clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}` }) as { id: string }; return { content: json({ taskId: task.id }), waitFor: { kind: 'media', id: task.id } }; } },
    { name: 'generate_video', risk: 'cost', requires: ['video'], description: '用视频模型生成片段（产生费用，需要用户批准）。传 characterIds 自动拼接一致性锚点；imageAssetId 为首帧（可来自 frame_handoff）；useReference=true 且未给首帧时用第一个角色的参考图作首帧。', parameters: object({ expectedRevision: int('当前工程版本'), prompt: str('画面与运动描述'), shotId: str('关联镜头'), imageAssetId: str('可选：首帧图片素材 ID'), characterIds: { type: 'array', items: { type: 'string' } }, useReference: { type: 'boolean' } }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) {
        let image = typeof args.imageAssetId === 'string' && args.imageAssetId ? args.imageAssetId : '';
        if (!image && args.useReference === true) { const story = await ctx.docs.story(); const first = ids(args.characterIds).map(id => story.characters.find(c => c.id === id || c.name === id)).find(c => c?.referenceAssetIds.length); if (first) image = first.referenceAssetIds[0]; }
        const task = await rpc(ctx, 'media.generate', { expectedRevision: revision(args), operation: image ? 'image-to-video' : 'text-to-video', prompt: await anchored(ctx, args), ...(args.shotId ? { shotId: args.shotId } : {}), ...(image ? { imageAssetIds: [image], allowImageUpload: true } : {}), clientRequestId: `${ctx.runId}.${String(args.__callId ?? '')}` }) as { id: string }; return { content: json({ taskId: task.id, firstFrame: image || undefined }), waitFor: { kind: 'media', id: task.id } }; } },
    { name: 'media_apply', risk: 'write', description: '把已就绪的生成素材采用到工程。', parameters: object({ taskId: str('媒体任务 ID'), expectedRevision: int('当前工程版本') }, ['taskId', 'expectedRevision']),
      async run(args, ctx) { const value = await rpc(ctx, 'media.apply', { taskId: need(args, 'taskId'), expectedRevision: revision(args) }); return { content: json(value) }; } },
    { name: 'generate_voice', risk: 'cost', requires: ['speech'], description: '为镜头生成配音（产生费用，需要用户批准）。', parameters: object({ shotId: str('镜头 ID'), text: str('旁白文字') }, ['shotId', 'text']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.voice) throw new Error('未配置配音'); const asset = await ctx.port.voice(ctx.projectId, need(args, 'shotId'), need(args, 'text'), ctx.signal); return { content: json({ ok: true, assetId: asset.id, name: asset.name }) }; } },
    { name: 'generate_music', risk: 'cost', requires: ['music'], description: '用已接入的音乐模型生成背景音乐并导入为素材（产生费用，需要用户批准）。之后用 audio_edit 放到音轨。', parameters: object({ prompt: str('风格、情绪、乐器、节奏'), durationSeconds: { type: 'number', description: '时长（秒）' } }, ['prompt']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.generateAudio) throw new Error('未配置音乐生成'); const asset = await ctx.port.generateAudio(ctx.projectId, 'music', need(args, 'prompt'), { durationSeconds: Number(args.durationSeconds) || undefined, signal: ctx.signal }); return { content: json({ ok: true, assetId: asset.id, name: asset.name, hint: '用 audio_edit 把它加入音轨' }), cost: asset.cost ?? null }; } },
    { name: 'generate_sfx', risk: 'cost', requires: ['sfx'], description: '用已接入的音效模型生成音效并导入为素材（产生费用，需要用户批准）。', parameters: object({ prompt: str('音效描述'), durationSeconds: { type: 'number', description: '时长（秒）' } }, ['prompt']),
      estimate: () => null,
      async run(args, ctx) { if (!ctx.port.generateAudio) throw new Error('未配置音效生成'); const asset = await ctx.port.generateAudio(ctx.projectId, 'sfx', need(args, 'prompt'), { durationSeconds: Number(args.durationSeconds) || undefined, signal: ctx.signal }); return { content: json({ ok: true, assetId: asset.id, name: asset.name, hint: '用 audio_edit 把它加入音轨' }), cost: asset.cost ?? null }; } },
    { name: 'synthesize_sfx', risk: 'write', fallbackFor: ['sfx'], description: '未接入音效模型时，在本地合成简单音效（提示音、扫频、风声、点击、钟声、噪声冲击）并导入为音频素材，免费。之后用 audio_edit 放到音轨。',
      parameters: object({ name: str('素材名称'), kind: { type: 'string', enum: ['tone', 'sweep', 'chime', 'noise', 'whoosh', 'click'] }, durationSeconds: { type: 'number' }, frequency: { type: 'number' }, endFrequency: { type: 'number' }, volume: { type: 'number' } }, ['kind', 'durationSeconds']),
      async run(args, ctx) {
        if (!ctx.port.importAudio) throw new Error('当前环境不能导入音频');
        const kind = String(args.kind); if (!['tone', 'sweep', 'chime', 'noise', 'whoosh', 'click'].includes(kind)) throw new Error('kind 无效');
        const bytes = synthesize({ ...(args as unknown as SynthSpec), kind: kind as SynthSpec['kind'] });
        const asset = await ctx.port.importAudio(ctx.projectId, typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 60) : '合成音效 · ' + kind, bytes, 'audio/wav');
        return { content: json({ ok: true, assetId: asset.id, name: asset.name, bytes: bytes.length, hint: '用 audio_edit 把它加入音轨' }) };
      } },
    { name: 'run_workflow', risk: 'cost', description: '启动固定协作流程（导演→画面→配音→视觉检查），可能调用生成模型（需要用户批准）。', parameters: object({ expectedRevision: int('当前工程版本'), prompt: str('制作要求') }, ['expectedRevision', 'prompt']),
      estimate: () => null,
      async run(args, ctx) { const record = await rpc(ctx, 'workflows.run', { expectedRevision: revision(args), prompt: need(args, 'prompt') }) as { id: string }; return { content: json({ workflowId: record.id }), waitFor: { kind: 'workflow', id: record.id } }; } },
    { name: 'export_mp4', risk: 'export', description: '导出当前版本为 MP4（需要用户批准）。导出前自动质检；有严重问题时拒绝导出，确需导出传 force=true。', parameters: object({ force: { type: 'boolean' } }),
      async run(args, ctx) {
        const report = await qualityCheck(ctx);
        if (!report.pass && args.force !== true) return { content: json({ ok: false, blocked: true, message: '导出前质检未通过，先修复下列问题（或确认后用 force=true 强制导出）', issues: report.issues }) };
        await rpc(ctx, 'export', {}); return { content: json({ ok: true, message: '已开始导出，可在「任务记录」查看进度', qc: { pass: report.pass, issues: report.issues.length } }) };
      } },
    { name: 'skill_read', risk: 'read', description: '读取导演技能文档（按主题）：' + skillIndex() + '。写镜头源码前按需查阅。', parameters: object({ topic: { type: 'string', enum: Object.keys(SKILLS) } }, ['topic']),
      async run(args) { const skill = SKILLS[String(args.topic)]; if (!skill) throw new Error('未知主题；可选：' + Object.keys(SKILLS).join(', ')); return { content: `# ${skill.title}\n${skill.body}` }; } },
    { name: 'story_get', risk: 'read', description: '读取创作计划（剧本、风格、角色库、分镜表、一致性分数）。', parameters: object({}),
      async run(_args, ctx) { return { content: json(await ctx.docs.story()) }; } },
    { name: 'plan_story', risk: 'plan', description: '提交（或整体替换）创作计划的剧本层：标题、梗概、目标时长、风格、角色（可见特征要具体）。需要用户审批，批准后才保存。', parameters: object({
        title: str('标题'), logline: str('一句话梗概/剧本要点'), targetSeconds: { type: 'number' },
        style: object({ look: str('画风'), palette: str('配色'), typography: str('字体'), motion: str('运动风格'), negative: str('避免的元素') }),
        characters: { type: 'array', items: object({ id: str('角色 ID，如 hero'), name: str('名字'), description: str('描述'), features: { type: 'array', items: { type: 'string' } }, voice: str('音色') }, ['name']) },
      }, ['title', 'logline', 'style']),
      async run(args, ctx) {
        const title = need(args, 'title').slice(0, 80), logline = need(args, 'logline').slice(0, 1200), style = normalizeStyle(args.style);
        const incoming = Array.isArray(args.characters) ? args.characters.slice(0, 20).map(normalizeCharacter) : [];
        const target = Number(args.targetSeconds);
        const story = await ctx.docs.updateStory(current => {
          const characters = incoming.map(c => { const old = current.characters.find(o => o.id === c.id); return old ? { ...c, referenceAssetIds: c.referenceAssetIds.length ? c.referenceAssetIds : old.referenceAssetIds } : c; });
          const kept = current.characters.filter(c => !characters.some(n => n.id === c.id) && current.shots.some(s => s.characters.includes(c.id)));
          return { ...current, title, logline, targetSeconds: Number.isFinite(target) && target > 0 ? Math.min(target, 3600) : current.targetSeconds, style, characters: [...characters, ...kept], status: 'approved', approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        });
        return { content: json({ ok: true, version: story.version, characters: story.characters.map(c => c.id), next: story.shots.length ? '如需调整分镜，用 plan_shots' : '下一步用 plan_shots 提交分镜表' }) };
      } },
    { name: 'plan_shots', risk: 'plan', description: '提交（整体替换）分镜表：每镜摘要、景别、运镜、时长、台词、出场角色、是否承接上一镜尾帧、对应工程镜头 shotId（可选）。需要用户审批。', parameters: object({
        shots: { type: 'array', items: object({ id: str('分镜 ID'), shotId: str('对应工程镜头 ID（已有时）'), summary: str('画面与情节'), shotType: str('景别：远/全/中/近/特写'), camera: str('运镜'), durationSeconds: { type: 'number' }, dialogue: str('台词/旁白'), characters: { type: 'array', items: { type: 'string' } }, continueFromPrevious: { type: 'boolean' } }, ['summary', 'durationSeconds']) },
      }, ['shots']),
      async run(args, ctx) {
        const story = await ctx.docs.updateStory(current => {
          if (!current.title) throw new Error('先用 plan_story 提交剧本与风格');
          const shots = normalizeShots(args.shots, current.characters);
          return { ...current, shots, consistency: Object.fromEntries(Object.entries(current.consistency).filter(([k]) => shots.some(s => (s.shotId ?? s.id) === k))), status: 'approved', approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        });
        return { content: json({ ok: true, version: story.version, shots: story.shots.length, totalSeconds: story.shots.reduce((s, x) => s + x.durationSeconds, 0) }) };
      } },
    { name: 'character_upsert', risk: 'write', description: '新增或更新角色库中的一个角色（可见特征、参考图素材 ID、音色）。参考图须是工程中已有的图片素材。', parameters: object({ id: str('角色 ID'), name: str('名字'), description: str('描述'), features: { type: 'array', items: { type: 'string' } }, referenceAssetIds: { type: 'array', items: { type: 'string' } }, voice: str('音色') }, ['id', 'name']),
      async run(args, ctx) {
        const snapshot = await ctx.port.snapshot(ctx.projectId); const character = normalizeCharacter(args, 0);
        const bad = character.referenceAssetIds.filter(id => !snapshot.project?.assets.some(a => a.id === id && a.kind === 'image')); if (bad.length) throw new Error('参考图不是工程中的图片素材：' + bad.join(', '));
        const story = await ctx.docs.updateStory(current => ({ ...current, characters: [...current.characters.filter(c => c.id !== character.id), character], updatedAt: new Date().toISOString() }));
        return { content: json({ ok: true, version: story.version, character }) };
      } },
    { name: 'consistency_review', risk: 'read', requires: ['vision'], description: '按分镜截取关键帧，让视觉模型对照计划中的风格与角色特征打 0–100 分，结果写入计划。低于阈值的镜头会给出重生建议（重生仍需用户批准）。', parameters: object({ shotIds: { type: 'array', items: { type: 'string' } }, threshold: { type: 'number' } }),
      async run(args, ctx) {
        if (!ctx.port.vision) return { content: json({ skipped: true, reason: '未接入视觉检查模型' }) };
        const story = await ctx.docs.story(); if (story.status !== 'approved') return { content: json({ skipped: true, reason: '还没有已批准的创作计划；先 plan_story / plan_shots' }) };
        const project = (await ctx.port.snapshot(ctx.projectId)).project; if (!project) throw new Error('没有打开的工程');
        const threshold = Number.isFinite(Number(args.threshold)) ? Math.max(1, Math.min(100, Number(args.threshold))) : 75;
        const wanted = Array.isArray(args.shotIds) ? new Set(args.shotIds.map(String)) : null; const frames = keyframes(project).filter(f => !wanted || wanted.has(f.shotId)).slice(0, 6);
        if (!frames.length) return { content: json({ skipped: true, reason: '没有可检查的镜头' }) };
        const images = []; for (const f of frames) { const shot = await ctx.port.capture(ctx.projectId, f.frame, ctx.signal); images.push({ mime: shot.mime, bytes: shot.bytes }); }
        const expect = frames.map(f => { const planned = story.shots.find(s => s.shotId === f.shotId); return `${f.shotId}：${planned ? planned.summary + '；角色 ' + (planned.characters.map(id => story.characters.find(c => c.id === id)?.name ?? id).join('、') || '无') : '（计划外镜头）'}`; }).join('\n');
        const answer = await ctx.port.vision(`对照创作计划检查每张关键帧的角色与风格一致性（图片顺序同下列镜头）。\n风格：${JSON.stringify(story.style)}\n角色特征：${story.characters.map(c => `${c.name}=${[c.description, ...c.features].join('，')}`).join('；') || '无'}\n镜头：\n${expect}\n只输出 JSON：{"scores":[{"shotId":"","score":0-100,"notes":"不一致之处"}]}`, images, ctx.signal);
        let scores: { shotId: string; score: number; notes: string }[] = [];
        try { const v = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)); scores = (Array.isArray(v.scores) ? v.scores : []).filter((x: { shotId?: unknown }) => frames.some(f => f.shotId === x.shotId)).map((x: { shotId: string; score: unknown; notes?: unknown }) => ({ shotId: x.shotId, score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))), notes: String(x.notes ?? '').slice(0, 300) })); }
        catch { return { content: json({ error: '视觉模型没有返回可解析的分数', raw: bound(answer, 800) }) }; }
        const at = new Date().toISOString();
        await ctx.docs.updateStory(current => ({ ...current, consistency: { ...current.consistency, ...Object.fromEntries(scores.map(s => [s.shotId, { ...s, at }])) } }));
        const low = scores.filter(s => s.score < threshold);
        return { content: json({ threshold, scores, proposals: low.map(s => ({ shotId: s.shotId, action: '建议重生', how: '用 generate_image/generate_video 并传 characterIds（需用户批准）；或手动修改镜头源码', notes: s.notes })) }) };
      } },
    { name: 'frame_handoff', risk: 'write', requires: ['video'], description: '尾帧承接：截取上一个镜头的最后一帧，导入为图片素材，返回 assetId，用作下一镜 generate_video 的 imageAssetId（首帧）。', parameters: object({ shotId: str('要承接的（后一个）镜头 ID') }, ['shotId']),
      async run(args, ctx) {
        if (!ctx.port.importImage) throw new Error('当前环境不能导入图片');
        const project = (await ctx.port.snapshot(ctx.projectId)).project; if (!project) throw new Error('没有打开的工程');
        const order = project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id); const index = order.indexOf(need(args, 'shotId'));
        if (index < 0) throw new Error('镜头不存在'); if (index === 0) throw new Error('第一个镜头没有上一镜可承接');
        let end = 0; for (let i = 0; i < index; i++) end += project.shots.find(s => s.id === order[i])!.durationFrames;
        const frame = await ctx.port.capture(ctx.projectId, end - 1, ctx.signal);
        const asset = await ctx.port.importImage(ctx.projectId, `尾帧承接 · ${order[index - 1]}→${order[index]}`, frame.bytes, frame.mime);
        return { content: json({ ok: true, assetId: asset.id, fromShot: order[index - 1], frame: end - 1, hint: '把 assetId 作为 generate_video 的 imageAssetId' }) };
      } },
    { name: 'align_to_voice', risk: 'write', description: '配音对齐：按每个镜头的配音时长调整镜头时长（配音 + 余量），并把配音片段对齐到镜头开头。一次提交，可撤销。', parameters: object({ expectedRevision: int('当前工程版本'), paddingSeconds: { type: 'number', description: '配音后的余量，默认 0.4 秒' }, shotIds: { type: 'array', items: { type: 'string' } } }, ['expectedRevision']),
      async run(args, ctx) {
        const project = structuredClone((await ctx.port.snapshot(ctx.projectId)).project); if (!project) throw new Error('没有打开的工程');
        const expected = revision(args); if (expected !== project.revision) throw Object.assign(new Error('版本已变化'), { code: 'REVISION_CONFLICT' });
        const pad = Number.isFinite(Number(args.paddingSeconds)) ? Math.max(0, Math.min(5, Number(args.paddingSeconds))) : 0.4;
        const wanted = Array.isArray(args.shotIds) ? new Set(args.shotIds.map(String)) : null;
        const changes = alignToVoice(project, pad, wanted);
        if (!changes.length) return { content: json({ ok: true, changed: 0, message: '没有需要对齐的配音（镜头需有带时长的配音片段）' }) };
        const next = await ctx.port.commit(ctx.projectId, expected, project, {}, '智能体：配音对齐');
        return { content: json({ ok: true, revision: next.project?.revision, changes }), revision: next.project?.revision };
      } },
    { name: 'quality_check', risk: 'read', description: '导出前质检：黑帧/纯色帧、静音（缺音轨、音量为 0、有台词无配音字幕）、字幕越界与配音超出镜头、时长偏差、一致性低分。', parameters: object({}),
      async run(_args, ctx) { return { content: json(await qualityCheck(ctx)) }; } },
  ];
  return tools;
}

/** Select the tools exposed to the model for the currently bound generation roles. */
export function activeTools(all: AgentTool[], capabilities: Capabilities): AgentTool[] {
  const roles = new Set(capabilities.roles);
  return all.filter(tool => (tool.requires ?? []).every(role => roles.has(role)) && !(tool.fallbackFor ?? []).some(role => roles.has(role)))
    .filter(tool => tool.name !== 'media_apply' || roles.has('image') || roles.has('video'));
}
