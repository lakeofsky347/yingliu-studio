import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import type { VideoProject } from '../shared/types.ts';

export interface StoryStyle { look: string; palette: string; typography: string; motion: string; negative: string }
export interface StoryCharacter { id: string; name: string; description: string; features: string[]; referenceAssetIds: string[]; voice?: string }
export interface StoryShot { id: string; shotId?: string; summary: string; shotType: string; camera: string; durationSeconds: number; dialogue: string; characters: string[]; continueFromPrevious: boolean }
export interface ConsistencyScore { shotId: string; score: number; notes: string; at: string }
export interface Story {
  version: number; projectId: string; status: 'empty' | 'approved'; title: string; logline: string; targetSeconds: number;
  style: StoryStyle; characters: StoryCharacter[]; shots: StoryShot[]; approvedAt?: string; updatedAt: string;
  consistency: Record<string, ConsistencyScore>;
}
export interface Ledger { version: number; projectId: string; maxCost: number | null; currency: string; spent: number; unknownCostCalls: number; byTool: Record<string, { calls: number; cost: number }>; updatedAt: string }

const SAFE = /^[a-zA-Z0-9_-]{1,120}$/;
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value: unknown, max: number, each: number) => Array.isArray(value) ? value.map(item => text(item, each)).filter(Boolean).slice(0, max) : [];
const id = (value: unknown, fallback: string) => { const v = text(value, 60).replace(/[^a-zA-Z0-9_-]/g, ''); return v || fallback; };

export function emptyStory(projectId: string): Story {
  return { version: 0, projectId, status: 'empty', title: '', logline: '', targetSeconds: 0, style: { look: '', palette: '', typography: '', motion: '', negative: '' }, characters: [], shots: [], updatedAt: new Date(0).toISOString(), consistency: {} };
}
export function normalizeStyle(value: unknown): StoryStyle { const v = (value ?? {}) as Record<string, unknown>; return { look: text(v.look, 400), palette: text(v.palette, 200), typography: text(v.typography, 200), motion: text(v.motion, 300), negative: text(v.negative, 300) }; }
export function normalizeCharacter(value: unknown, index: number): StoryCharacter {
  const v = (value ?? {}) as Record<string, unknown>; const name = text(v.name, 40); if (!name) throw new Error(`角色 ${index + 1} 缺少 name`);
  return { id: id(v.id, 'c' + (index + 1)), name, description: text(v.description, 600), features: list(v.features, 12, 80), referenceAssetIds: list(v.referenceAssetIds, 6, 80), ...(text(v.voice, 80) ? { voice: text(v.voice, 80) } : {}) };
}
export function normalizeShots(value: unknown, characters: StoryCharacter[]): StoryShot[] {
  if (!Array.isArray(value) || !value.length) throw new Error('shots 必须是非空数组');
  if (value.length > 60) throw new Error('分镜最多 60 个');
  const known = new Set(characters.map(c => c.id)); const seen = new Set<string>();
  return value.map((raw, index) => {
    const v = (raw ?? {}) as Record<string, unknown>; const summary = text(v.summary, 600); if (!summary) throw new Error(`分镜 ${index + 1} 缺少 summary`);
    let shotId = id(v.id, 's' + (index + 1)); while (seen.has(shotId)) shotId += '_'; seen.add(shotId);
    const duration = Number(v.durationSeconds); if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error(`分镜 ${index + 1} 的 durationSeconds 须在 0–120 秒`);
    const chars = list(v.characters, 8, 60); const unknown = chars.filter(c => !known.has(c)); if (unknown.length) throw new Error(`分镜 ${index + 1} 引用了未知角色：${unknown.join(', ')}（先用 plan_story 或 character_upsert 定义）`);
    return { id: shotId, ...(text(v.shotId, 80) ? { shotId: text(v.shotId, 80) } : {}), summary, shotType: text(v.shotType, 40), camera: text(v.camera, 120), durationSeconds: Math.round(duration * 100) / 100, dialogue: text(v.dialogue, 600), characters: chars, continueFromPrevious: v.continueFromPrevious === true };
  });
}

/** Text anchors injected into every generation prompt so style and characters stay consistent across shots. */
export function anchorPrompt(story: Story | null, characterIds: string[] = []): string {
  if (!story) return '';
  const parts: string[] = [];
  const s = story.style; const style = [s.look && '画风：' + s.look, s.palette && '配色：' + s.palette, s.motion && '运动：' + s.motion].filter(Boolean).join('；');
  if (style) parts.push(style);
  for (const cid of characterIds) { const c = story.characters.find(x => x.id === cid || x.name === cid); if (c) parts.push(`角色「${c.name}」：${[c.description, ...c.features].filter(Boolean).join('，')}`); }
  if (s.negative) parts.push('避免：' + s.negative);
  return parts.length ? '\n【一致性锚点】' + parts.join('。') : '';
}
export function storyBrief(story: Story | null): string {
  if (!story || story.status !== 'approved') return '';
  const shots = story.shots.map((s, i) => `${i + 1}. [${s.id}${s.shotId ? '→' + s.shotId : ''}] ${s.shotType} ${s.camera} ${s.durationSeconds}s ${s.summary}${s.characters.length ? '（角色 ' + s.characters.join(',') + '）' : ''}${s.continueFromPrevious ? '（承接上一镜）' : ''}`).join('\n');
  return `已批准的创作计划（按此执行，偏离前先用 plan_shots 更新）：\n《${story.title}》${story.logline}\n风格：${JSON.stringify(story.style)}\n角色：${story.characters.map(c => `${c.id}=${c.name}（${c.features.join('，')}）`).join('；') || '无'}\n分镜：\n${shots}`.slice(0, 6000);
}

/** Per-project JSON documents (story, ledger) with atomic writes and optimistic versioning. */
export class ProjectDocs<T extends { version: number }> {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly empty: (projectId: string) => T) {}
  private file(projectId: string) { if (!SAFE.test(projectId)) throw new Error('工程 ID 无效'); return join(this.directory, projectId + '.json'); }
  async get(projectId: string): Promise<T> { await this.queue.catch(() => {}); try { return JSON.parse(await readFile(this.file(projectId), 'utf8')) as T; } catch { return this.empty(projectId); } }
  update(projectId: string, change: (current: T) => T, expectedVersion?: number): Promise<T> {
    const work = async () => {
      const current = await this.read(projectId);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw Object.assign(new Error(`版本已变化（当前 ${current.version}），请重新读取`), { code: 'REVISION_CONFLICT' });
      const next = { ...change(structuredClone(current)), version: current.version + 1 };
      await mkdir(this.directory, { recursive: true });
      const file = this.file(projectId), temporary = file + '.tmp-' + randomUUID();
      try { await writeFile(temporary, JSON.stringify(next, null, 1)); await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
      return next;
    };
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  private async read(projectId: string): Promise<T> { try { return JSON.parse(await readFile(this.file(projectId), 'utf8')) as T; } catch { return this.empty(projectId); } }
}
export const emptyLedger = (projectId: string): Ledger => ({ version: 0, projectId, maxCost: null, currency: 'CNY', spent: 0, unknownCostCalls: 0, byTool: {}, updatedAt: new Date(0).toISOString() });

/** Mean luminance and spread of an 8-bit RGB/RGBA/gray PNG (no interlace). Returns null when it cannot decode. */
export function pngLuma(bytes: Uint8Array): { mean: number; std: number } | null {
  const b = Buffer.from(bytes); if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let p = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0; const data: Buffer[] = [];
  while (p + 8 <= b.length) { const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), body = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') data.push(body); else if (type === 'IEND') break; p += 12 + len; }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color]; if (!channels || depth !== 8 || interlace || !width || !height || width * height > 40_000_000) return null;
  let raw: Buffer; try { raw = inflateSync(Buffer.concat(data)); } catch { return null; }
  const stride = width * channels; if (raw.length < (stride + 1) * height) return null;
  let prev = Buffer.alloc(stride), sum = 0, sq = 0, n = 0; const step = Math.max(1, Math.floor(width / 200));
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) { const a = x >= channels ? line[x - channels] : 0, up = prev[x], c = x >= channels ? prev[x - channels] : 0;
      const pred = filter === 1 ? a : filter === 2 ? up : filter === 3 ? (a + up) >> 1 : filter === 4 ? (() => { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; })() : 0;
      line[x] = (line[x] + pred) & 255; }
    if (y % step === 0) for (let x = 0; x < width; x += step) { const o = x * channels; const l = channels >= 3 ? 0.2126 * line[o] + 0.7152 * line[o + 1] + 0.0722 * line[o + 2] : line[o]; sum += l; sq += l * l; n++; }
    prev = line;
  }
  const mean = sum / n; return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

export interface QcIssue { check: 'black' | 'silence' | 'subtitle' | 'duration' | 'consistency'; severity: 'low' | 'medium' | 'high'; shotId?: string; message: string }
export interface QcReport { pass: boolean; checkedAt: string; issues: QcIssue[]; unchecked: string[] }

/** Project-data checks (no rendering): silence, subtitle overflow, durations, consistency scores. */
export function dataChecks(project: VideoProject, story: Story | null, threshold = 75): QcIssue[] {
  const issues: QcIssue[] = []; const fps = project.target.fps.num / project.target.fps.den;
  const order = project.shotOrder.length ? project.shotOrder : project.shots.map(s => s.id); const shots = order.map(id => project.shots.find(s => s.id === id)).filter(Boolean) as VideoProject['shots'];
  const clips = project.audioClips ?? [];
  const total = shots.reduce((sum, s) => sum + s.durationFrames / fps, 0);
  if (project.target.audioMode === 'mixed' && !clips.length) issues.push({ check: 'silence', severity: 'medium', message: '音频模式为混音，但工程没有任何音轨（成片将是静音）' });
  for (const clip of clips) if (clip.volume <= 0) issues.push({ check: 'silence', severity: 'low', shotId: clip.shotId, message: `音频片段 ${clip.id} 音量为 0` });
  for (const clip of clips) if (!project.assets.some(a => a.id === clip.assetId)) issues.push({ check: 'silence', severity: 'high', shotId: clip.shotId, message: `音频片段 ${clip.id} 引用的素材不存在` });
  const perLine = Math.max(8, Math.floor(project.target.width / Math.max(24, project.target.height * 0.05) * 0.9));
  for (const shot of shots) {
    const seconds = shot.durationFrames / fps;
    if (seconds < 0.5) issues.push({ check: 'duration', severity: 'medium', shotId: shot.id, message: `镜头只有 ${seconds.toFixed(2)} 秒` });
    const subtitle = (shot.params as { subtitle?: string })?.subtitle ?? '';
    const lines = subtitle.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / perLine)), 0);
    if (subtitle && lines > 2) issues.push({ check: 'subtitle', severity: 'medium', shotId: shot.id, message: `字幕约 ${lines} 行（每行约 ${perLine} 字），可能越出安全区` });
    for (const clip of clips.filter(c => c.role === 'voice' && c.shotId === shot.id)) { const asset = project.assets.find(a => a.id === clip.assetId); const end = clip.startSeconds + (Math.min(clip.trimEnd ?? asset?.duration ?? 0, asset?.duration ?? 0) - clip.trimStart); if (asset?.duration && end > seconds + 0.05) issues.push({ check: 'subtitle', severity: 'medium', shotId: shot.id, message: `配音长 ${end.toFixed(2)}s，超出镜头时长 ${seconds.toFixed(2)}s，字幕与配音会错位；可用 align_to_voice 对齐` }); }
  }
  const target = story?.status === 'approved' && story.targetSeconds ? story.targetSeconds : story?.status === 'approved' && story.shots.length ? story.shots.reduce((s, x) => s + x.durationSeconds, 0) : project.targetDuration;
  if (target > 0 && Math.abs(total - target) / target > 0.2) issues.push({ check: 'duration', severity: 'medium', message: `总时长 ${total.toFixed(1)}s 与目标 ${target}s 相差超过 20%` });
  if (story?.status === 'approved') {
    for (const planned of story.shots) if (planned.dialogue && planned.shotId) { const shot = project.shots.find(s => s.id === planned.shotId); if (shot && !clips.some(c => c.role === 'voice' && c.shotId === shot.id) && !(shot.params as { subtitle?: string })?.subtitle && !shot.narration) issues.push({ check: 'silence', severity: 'medium', shotId: shot.id, message: '计划中有台词，但镜头既没有配音也没有字幕' }); }
    for (const score of Object.values(story.consistency)) if (score.score < threshold) issues.push({ check: 'consistency', severity: score.score < threshold - 25 ? 'high' : 'medium', shotId: score.shotId, message: `角色/风格一致性 ${score.score} 分（低于 ${threshold}）：${score.notes}` });
  }
  return issues;
}
export function frameIssue(shotId: string, luma: { mean: number; std: number } | null): QcIssue | null {
  if (!luma) return null;
  if (luma.mean < 8 && luma.std < 4) return { check: 'black', severity: 'high', shotId, message: `关键帧几乎全黑（平均亮度 ${luma.mean.toFixed(1)}）` };
  if (luma.std < 2) return { check: 'black', severity: 'medium', shotId, message: `关键帧是纯色画面（亮度 ${luma.mean.toFixed(1)}），可能内容未渲染` };
  return null;
}
