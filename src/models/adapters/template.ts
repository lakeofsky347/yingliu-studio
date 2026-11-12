import type { ModelDefinition, ProviderConnection } from '../contracts.ts';
import type { MediaArtifact, RemoteJob, RemoteStatus } from '../../jobs/contracts.ts';

/**
 * Configurable async-task adapter ("protocol template") for image / video / audio providers that
 * submit a job and poll for a result. Every field lives in the model's non-secret parameters, so
 * new providers need configuration, not code. Presets cover common shapes; any field can override.
 */
export interface TaskTemplate {
  submitPath: string; submitMethod: 'POST' | 'PUT'; submitBody: string;
  /** Dot path to the remote job id in the submit response. Empty → synchronous result. */
  idPath: string; pollPath: string; pollMethod: 'GET' | 'POST';
  statusPath: string; statusMap: string; resultPath: string; resultMime: string;
  errorPath: string; progressPath: string; progressScale: number; cancelPath: string; checkPath: string;
  /** json (default) or binary (submit response body is the media itself, e.g. TTS/SFX). */
  responseType: 'json' | 'binary';
  authHttpName: string; authPrefix: string; extraHttpName: string; extraHttpValue: string;
}
const BASE: TaskTemplate = {
  submitPath: '/tasks', submitMethod: 'POST', submitBody: '{"model":"{{model}}","prompt":"{{prompt}}"}',
  idPath: 'id', pollPath: '/tasks/{{id}}', pollMethod: 'GET', statusPath: 'status',
  statusMap: 'queued:queued,pending:queued,submitted:queued,starting:queued,running:running,processing:running,in_progress:running,succeeded:succeeded,success:succeeded,succeed:succeeded,completed:succeeded,failed:failed,error:failed,cancelled:cancelled,canceled:cancelled',
  resultPath: 'output', resultMime: '', errorPath: 'error', progressPath: '', progressScale: 1, cancelPath: '', checkPath: '',
  responseType: 'json', authHttpName: 'Authorization', authPrefix: 'Bearer ', extraHttpName: '', extraHttpValue: '',
};
export const TEMPLATE_PRESETS: Record<string, { label: string; output: 'image' | 'video' | 'audio'; template: Partial<TaskTemplate> }> = {
  'dashscope-image': { label: '通义万相 文生图（DashScope 异步）', output: 'image', template: {
    submitPath: '/services/aigc/text2image/image-synthesis', submitBody: '{"model":"{{model}}","input":{"prompt":"{{prompt}}"},"parameters":{"size":"{{param.size|1024*1024}}","n":1}}',
    extraHttpName: 'X-DashScope-Async', extraHttpValue: 'enable', idPath: 'output.task_id', pollPath: '/tasks/{{id}}', statusPath: 'output.task_status', resultPath: 'output.results[].url', errorPath: 'output.message',
    statusMap: 'PENDING:queued,RUNNING:running,SUCCEEDED:succeeded,FAILED:failed,CANCELED:cancelled,UNKNOWN:failed', checkPath: '' } },
  'dashscope-video': { label: '通义万相 生视频（DashScope 异步）', output: 'video', template: {
    submitPath: '/services/aigc/video-generation/video-synthesis', submitBody: '{"model":"{{model}}","input":{"prompt":"{{prompt}}","img_url":"{{image}}"},"parameters":{"duration":"{{duration|5}}"}}',
    extraHttpName: 'X-DashScope-Async', extraHttpValue: 'enable', idPath: 'output.task_id', pollPath: '/tasks/{{id}}', statusPath: 'output.task_status', resultPath: 'output.video_url', errorPath: 'output.message',
    statusMap: 'PENDING:queued,RUNNING:running,SUCCEEDED:succeeded,FAILED:failed,CANCELED:cancelled,UNKNOWN:failed' } },
  'kling-video': { label: '可灵 生视频（text2video / image2video）', output: 'video', template: {
    submitPath: '/v1/videos/text2video', submitBody: '{"model_name":"{{model}}","prompt":"{{prompt}}","duration":"{{duration|5}}"}',
    idPath: 'data.task_id', pollPath: '/v1/videos/text2video/{{id}}', statusPath: 'data.task_status', resultPath: 'data.task_result.videos[].url', errorPath: 'data.task_status_msg',
    statusMap: 'submitted:queued,processing:running,succeed:succeeded,failed:failed' } },
  'ark-video': { label: '火山方舟 / 即梦 Seedance 生视频', output: 'video', template: {
    submitPath: '/contents/generations/tasks', submitBody: '{"model":"{{model}}","content":[{"type":"text","text":"{{prompt}}"}]}',
    idPath: 'id', pollPath: '/contents/generations/tasks/{{id}}', statusPath: 'status', resultPath: 'content.video_url', errorPath: 'error.message', cancelPath: '' } },
  'runway-video': { label: 'Runway 生视频（image_to_video）', output: 'video', template: {
    submitPath: '/v1/image_to_video', submitBody: '{"model":"{{model}}","promptText":"{{prompt}}","promptImage":"{{image}}","duration":{{duration|5}}}',
    extraHttpName: 'X-Runway-Version', extraHttpValue: '2024-11-06', idPath: 'id', pollPath: '/v1/tasks/{{id}}', statusPath: 'status', resultPath: 'output[]', errorPath: 'failure',
    statusMap: 'PENDING:queued,THROTTLED:queued,RUNNING:running,SUCCEEDED:succeeded,FAILED:failed,CANCELLED:cancelled' } },
  'replicate': { label: 'Replicate（任意图片/视频/音频模型）', output: 'image', template: {
    submitPath: '/models/{{model}}/predictions', submitBody: '{"input":{"prompt":"{{prompt}}"}}', idPath: 'id', pollPath: '/predictions/{{id}}', statusPath: 'status', resultPath: 'output', errorPath: 'error', cancelPath: '/predictions/{{id}}/cancel' } },
  'elevenlabs-sfx': { label: 'ElevenLabs 音效（同步二进制）', output: 'audio', template: {
    submitPath: '/v1/sound-generation', submitBody: '{"text":"{{prompt}}","duration_seconds":{{duration|3}}}', responseType: 'binary', resultMime: 'audio/mpeg', idPath: '', authHttpName: 'xi-api-key', authPrefix: '' } },
  'openai-speech': { label: 'OpenAI 兼容 TTS（/audio/speech，同步二进制）', output: 'audio', template: {
    submitPath: '/audio/speech', submitBody: '{"model":"{{model}}","input":"{{prompt}}","voice":"{{param.voice|alloy}}","response_format":"mp3"}', responseType: 'binary', resultMime: 'audio/mpeg', idPath: '' } },
  'generic-async': { label: '通用异步任务（自定义字段）', output: 'image', template: {} },
};

const FIELDS = Object.keys(BASE) as (keyof TaskTemplate)[];
export function resolveTemplate(parameters: Record<string, unknown>): TaskTemplate {
  const preset = typeof parameters.preset === 'string' ? TEMPLATE_PRESETS[parameters.preset] : undefined;
  if (typeof parameters.preset === 'string' && !preset) throw new Error('未知的协议模板：' + parameters.preset);
  const result: TaskTemplate = { ...BASE, ...(preset?.template ?? {}) };
  for (const field of FIELDS) { const value = parameters[field]; if (value === undefined) continue; (result as unknown as Record<string, unknown>)[field] = field === 'progressScale' ? Number(value) : String(value); }
  for (const path of [result.submitPath, result.pollPath, result.cancelPath, result.checkPath]) if (path && (!path.startsWith('/') || /\/\/|\.\.|[\s#]/.test(path))) throw new Error('模板路径须以 / 开头且不含 .. 或空白');
  if (result.extraHttpName && !/^[A-Za-z0-9-]{1,64}$/.test(result.extraHttpName)) throw new Error('附加请求头名称无效');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(result.authHttpName)) throw new Error('认证请求头名称无效');
  if (/^(host|cookie|content-length|transfer-encoding)$/i.test(result.extraHttpName) || /auth|key|token|secret|cookie/i.test(result.extraHttpName)) throw new Error('附加请求头不能用于凭据；API Key 请填在连接的凭据中');
  return result;
}
export function templateOutput(parameters: Record<string, unknown>): 'image' | 'video' | 'audio' | undefined {
  return typeof parameters.preset === 'string' ? TEMPLATE_PRESETS[parameters.preset]?.output : undefined;
}

export interface TemplateVars { prompt: string; model: string; clientRequestId: string; image?: string; duration?: number; parameters: Record<string, unknown>; id?: string }
function lookupVar(vars: TemplateVars, name: string): unknown {
  if (name.startsWith('param.')) return vars.parameters[name.slice(6)];
  return ({ prompt: vars.prompt, model: vars.model, clientRequestId: vars.clientRequestId, image: vars.image, duration: vars.duration, id: vars.id } as Record<string, unknown>)[name];
}
function token(vars: TemplateVars, expression: string): unknown {
  const [name, fallback] = expression.split('|', 2); const value = lookupVar(vars, name.trim());
  if (value === undefined || value === '' || value === null) return fallback === undefined ? undefined : (/^-?\d+(\.\d+)?$/.test(fallback) ? Number(fallback) : fallback);
  return value;
}
/** Fill a path template; values are URL-encoded. */
export function fillPath(path: string, vars: TemplateVars): string {
  return path.replace(/\{\{([^}]+)\}\}/g, (_m, expr) => encodeURIComponent(String(token(vars, expr) ?? '')));
}
/**
 * Fill a JSON body template safely: placeholders are substituted inside the parsed structure, so prompt text can
 * never break out of its string. A string that is exactly one placeholder takes the raw value (numbers stay numbers);
 * fields whose placeholder is missing (e.g. no image) are dropped.
 */
export function fillBody(template: string, vars: TemplateVars): unknown {
  const prepared = template.replace(/(:\s*)\{\{([^}]+)\}\}/g, (_m, colon, expr) => `${colon}"@@tpl:${expr}@@"`);
  let parsed: unknown; try { parsed = JSON.parse(prepared); } catch { throw new Error('请求体模板不是有效 JSON'); }
  const DROP = Symbol('drop');
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = /^(?:@@tpl:([^@]+)@@|\{\{([^}]+)\}\})$/.exec(value);
      if (exact) { const v = token(vars, exact[1] ?? exact[2]); return v === undefined ? DROP : v; }
      return value.replace(/\{\{([^}]+)\}\}/g, (_m, expr) => String(token(vars, expr) ?? ''));
    }
    if (Array.isArray(value)) return value.map(walk).filter(item => item !== DROP);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]).filter(([, v]) => v !== DROP));
    return value;
  };
  return walk(parsed);
}
/** Dot path with `[]` to flatten arrays and `[n]` to index: `output.results[].url`, `data[0].url`. */
export function pick(value: unknown, path: string): unknown[] {
  if (!path) return [value];
  let current: unknown[] = [value];
  for (const segment of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d*\])*)$/.exec(segment); if (!match) return [];
    const next: unknown[] = [];
    for (const item of current) {
      let values: unknown[] = [match[1] ? (item && typeof item === 'object' ? (item as Record<string, unknown>)[match[1]] : undefined) : item];
      for (const index of match[2].match(/\[\d*\]/g) ?? []) {
        const n = index.slice(1, -1);
        values = values.flatMap(v => Array.isArray(v) ? (n === '' ? v : [v[Number(n)]]) : n === '' && v !== undefined ? [v] : []);
      }
      next.push(...values);
    }
    current = next.filter(v => v !== undefined && v !== null);
  }
  return current;
}
export function mapStatus(raw: unknown, statusMap: string): RemoteStatus | undefined {
  const text = String(raw ?? ''); if (!text) return undefined;
  for (const pair of statusMap.split(',')) { const [from, to] = pair.split(':').map(s => s.trim()); if (from && (from === text || from.toLowerCase() === text.toLowerCase()) && ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(to)) return to as RemoteStatus; }
  return undefined;
}
function guessMime(url: string, fallback: string, output: string): string {
  if (fallback) return fallback;
  const ext = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url)?.[1]?.toLowerCase();
  const table: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac' };
  return (ext && table[ext]) || (output === 'video' ? 'video/mp4' : output === 'audio' ? 'audio/mpeg' : 'image/png');
}
export function parseTemplateJob(data: unknown, template: TaskTemplate, fallbackId: string, output: 'image' | 'video' | 'audio'): RemoteJob {
  const jobId = template.idPath ? String(pick(data, template.idPath)[0] ?? '') : fallbackId;
  if (!jobId || jobId.length > 500) throw new Error('媒体接口没有返回任务 ID（检查 idPath）');
  const urls = pick(data, template.resultPath).flatMap(v => typeof v === 'string' ? [v] : v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string' ? [(v as { url: string }).url] : []).filter(url => /^https?:\/\//.test(url) || /^data:/.test(url)).slice(0, 8);
  let status = template.statusPath ? mapStatus(pick(data, template.statusPath)[0], template.statusMap) : undefined;
  if (!status) status = urls.length ? 'succeeded' : template.idPath ? 'queued' : 'failed';
  if (status === 'succeeded' && !urls.length) throw new Error('任务成功但没有找到产物地址（检查 resultPath）');
  const artifacts: MediaArtifact[] = urls.map(url => url.startsWith('data:') ? { base64: url.slice(url.indexOf(',') + 1), mimeType: url.slice(5, url.indexOf(';')) } : { url, mimeType: guessMime(url, template.resultMime, output) });
  const progressRaw = template.progressPath ? Number(pick(data, template.progressPath)[0]) : NaN;
  const progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(1, progressRaw / (template.progressScale || 1))) : undefined;
  const error = template.errorPath ? pick(data, template.errorPath)[0] : undefined;
  return { jobId, status, ...(artifacts.length ? { artifacts } : {}), ...(progress !== undefined ? { progress } : {}), ...(status === 'failed' && error !== undefined ? { error: String(typeof error === 'object' ? JSON.stringify(error) : error).slice(0, 1000) } : {}) };
}

export interface TemplateContext { connection: ProviderConnection; key?: string; signal: AbortSignal; fetch?: typeof fetch }
function headers(context: TemplateContext, template: TaskTemplate, json: boolean): Record<string, string> {
  if (context.connection.auth === 'bearer' && !context.key) throw Object.assign(new Error('媒体服务凭据不可用，请配置或解锁后重试'), { code: 'NEEDS_CREDENTIALS' });
  return { Accept: template.responseType === 'binary' ? '*/*' : 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(context.connection.auth === 'bearer' ? { [template.authHttpName]: template.authPrefix + context.key } : {}),
    ...(template.extraHttpName ? { [template.extraHttpName]: template.extraHttpValue } : {}) };
}
function url(connection: ProviderConnection, path: string) { return connection.baseUrl.replace(/\/+$/, '') + path; }
async function readJson(response: Response, key?: string): Promise<unknown> {
  const text = await response.text(); if (text.length > 48 * 1024 * 1024) throw new Error('媒体接口 JSON 响应过大');
  if (!response.ok) { const body = key ? text.split(key).join('[redacted]') : text; throw Object.assign(new Error(`媒体接口请求失败（HTTP ${response.status}）：${body.slice(0, 300)}`), { httpStatus: response.status, status: response.status, retryable: response.status === 429 || response.status >= 500 }); }
  try { return JSON.parse(text); } catch { throw new Error('媒体接口返回无效 JSON'); }
}
export interface TemplateInput { clientRequestId: string; model: ModelDefinition; prompt: string; image?: string; duration?: number; parameters: Record<string, unknown> }
export interface BinaryResult { kind: 'binary'; bytes: Uint8Array; mimeType: string }

export async function submitTemplate(context: TemplateContext, input: TemplateInput, output: 'image' | 'video' | 'audio'): Promise<RemoteJob | BinaryResult> {
  const template = resolveTemplate(input.model.parameters);
  const vars: TemplateVars = { prompt: input.prompt, model: input.model.model, clientRequestId: input.clientRequestId, image: input.image, duration: input.duration, parameters: { ...input.model.parameters, ...input.parameters } };
  const response = await (context.fetch ?? fetch)(url(context.connection, fillPath(template.submitPath, vars)), { method: template.submitMethod, redirect: 'error', headers: headers(context, template, true), body: JSON.stringify(fillBody(template.submitBody, vars)), signal: AbortSignal.any([context.signal, AbortSignal.timeout(context.connection.requestTimeoutMs)]) });
  if (template.responseType === 'binary') {
    if (!response.ok) await readJson(response, context.key);
    const bytes = new Uint8Array(await response.arrayBuffer()); if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('媒体接口返回的文件为空或超过 64 MiB');
    return { kind: 'binary', bytes, mimeType: template.resultMime || response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg' };
  }
  return parseTemplateJob(await readJson(response, context.key), template, input.clientRequestId, output);
}
export async function pollTemplate(context: TemplateContext, model: ModelDefinition, jobId: string, output: 'image' | 'video' | 'audio'): Promise<RemoteJob> {
  const template = resolveTemplate(model.parameters);
  const vars: TemplateVars = { prompt: '', model: model.model, clientRequestId: jobId, id: jobId, parameters: model.parameters };
  const response = await (context.fetch ?? fetch)(url(context.connection, fillPath(template.pollPath, vars)), { method: template.pollMethod, redirect: 'error', headers: headers(context, template, template.pollMethod === 'POST'), ...(template.pollMethod === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.any([context.signal, AbortSignal.timeout(context.connection.requestTimeoutMs)]) });
  const job = parseTemplateJob(await readJson(response, context.key), { ...template, idPath: '' }, jobId, output);
  return { ...job, jobId };
}
export async function cancelTemplate(context: TemplateContext, model: ModelDefinition, jobId: string): Promise<RemoteJob> {
  const template = resolveTemplate(model.parameters);
  if (!template.cancelPath) throw new Error('此服务模板未配置云端取消；已停止本地等待，请到服务控制台确认');
  const response = await (context.fetch ?? fetch)(url(context.connection, fillPath(template.cancelPath, { prompt: '', model: model.model, clientRequestId: jobId, id: jobId, parameters: model.parameters })), { method: 'POST', redirect: 'error', headers: headers(context, template, true), body: '{}', signal: AbortSignal.any([context.signal, AbortSignal.timeout(context.connection.requestTimeoutMs)]) });
  await readJson(response, context.key);
  return { jobId, status: 'cancelled' };
}
/** Non-billable reachability check: GET checkPath (or base URL). Any HTTP answer means reachable; 401/403 flags credentials. */
export async function checkTemplate(context: TemplateContext, model?: ModelDefinition): Promise<{ ok: boolean; message: string }> {
  const template = resolveTemplate(model?.parameters ?? {});
  const response = await (context.fetch ?? fetch)(url(context.connection, template.checkPath || '/'), { method: 'GET', redirect: 'manual', headers: context.connection.auth === 'bearer' && context.key ? { [template.authHttpName]: template.authPrefix + context.key } : {}, signal: AbortSignal.any([context.signal, AbortSignal.timeout(15000)]) });
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) return { ok: false, message: `服务可访问，但凭据被拒绝（HTTP ${response.status}）；未执行生成` };
  return { ok: true, message: `服务可访问（HTTP ${response.status}）；连通性检查不提交生成任务，真实生成为 NOT_CHECKED` };
}
