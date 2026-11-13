import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentTool, ModelTurn, ToolCall } from './tool-contracts.ts';

export interface ChatConfig {
  baseUrl: string; model: string; key?: string; timeoutMs: number; temperature?: number; maxTokens: number;
  /** false → fall back to the plan-JSON protocol used by the existing director. */
  supportsTools: boolean;
}
export class ModelHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) { super(message); }
}
function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function redactKey(text: string, key?: string): string { return key ? text.split(key).join('[redacted]') : text; }

export function toolSchemas(tools: AgentTool[]) {
  return tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

/** Plan-JSON fallback: one JSON object per turn, same shape as the existing director protocol. */
export function planJsonSystem(tools: AgentTool[]): string {
  return '当前模型不支持原生函数调用。每轮只输出一个 JSON 对象，不要输出其他文字：{"message":"给用户的说明","done":true|false,"actions":[{"tool":"工具名","arguments":{...}}]}。done=true 且 actions 为空表示任务结束。可用工具：\n'
    + tools.map(tool => `- ${tool.name}（${tool.risk}）：${tool.description} 参数：${JSON.stringify(tool.parameters)}`).join('\n');
}
function flattenForPlan(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') out.push({ role: 'user', content: `工具结果[${message.tool_call_id}]：${message.content}` });
    else if (message.role === 'assistant') {
      const calls = message.tool_calls?.map(call => ({ tool: call.function.name, arguments: safeJson(call.function.arguments) })) ?? [];
      out.push({ role: 'assistant', content: JSON.stringify({ message: message.content ?? '', done: false, actions: calls }) });
    } else out.push(message);
  }
  return out;
}
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return {}; } }
export function parsePlanJson(text: string): { content: string; toolCalls: ToolCall[]; done: boolean } {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { content: text.trim(), toolCalls: [], done: true };
  let plan: Record<string, unknown>;
  try { plan = obj(JSON.parse(text.slice(start, end + 1))); } catch { return { content: text.trim(), toolCalls: [], done: true }; }
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const toolCalls = actions.map(raw => { const action = obj(raw); return { id: 'plan-' + randomUUID(), name: String(action.tool ?? ''), arguments: JSON.stringify(action.arguments ?? {}) }; }).filter(call => call.name);
  return { content: typeof plan.message === 'string' ? plan.message : '', toolCalls, done: plan.done === true || !toolCalls.length };
}

export async function chatTurn(config: ChatConfig, system: string, messages: AgentMessage[], tools: AgentTool[], signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ModelTurn> {
  const mode = config.supportsTools ? 'tools' : 'plan-json';
  const body: Record<string, unknown> = {
    model: config.model, max_tokens: config.maxTokens, stream: false,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    messages: [{ role: 'system', content: mode === 'tools' ? system : system + '\n\n' + planJsonSystem(tools) }, ...(mode === 'tools' ? messages : flattenForPlan(messages))],
  };
  if (mode === 'tools' && tools.length) { body.tools = toolSchemas(tools); body.tool_choice = 'auto'; }
  const response = await fetchImpl(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = redactKey((await response.text().catch(() => '')).slice(0, 400), config.key);
    throw new ModelHttpError(`模型请求失败（HTTP ${response.status}）：${text}`, response.status, response.status === 429 || response.status >= 500);
  }
  const data = obj(await response.json()), choice = obj(Array.isArray(data.choices) ? data.choices[0] : undefined), message = obj(choice.message), usage = obj(data.usage);
  const tokens = { inputTokens: Number(usage.prompt_tokens) || 0, outputTokens: Number(usage.completion_tokens) || 0 };
  const content = redactKey(typeof message.content === 'string' ? message.content : '', config.key);
  const reason = String(choice.finish_reason ?? '');
  if (mode === 'plan-json') {
    const parsed = parsePlanJson(content);
    return { content: parsed.content, toolCalls: parsed.toolCalls, finish: reason === 'length' ? 'length' : parsed.toolCalls.length ? 'tool_calls' : 'stop', usage: tokens, mode };
  }
  const toolCalls: ToolCall[] = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(raw => {
    const call = obj(raw), fn = obj(call.function);
    return { id: typeof call.id === 'string' && call.id ? call.id : 'call-' + randomUUID(), name: String(fn.name ?? ''), arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}) };
  }).filter(call => call.name);
  return { content, toolCalls, finish: toolCalls.length ? 'tool_calls' : reason === 'length' ? 'length' : reason === 'stop' || !reason ? 'stop' : 'other', usage: tokens, mode };
}

/** Providers that reject the `tools` field answer 400/422 mentioning tools/function. */
export function looksLikeNoToolSupport(error: unknown): boolean {
  return error instanceof ModelHttpError && [400, 404, 422].includes(error.status) && /tool|function/i.test(error.message);
}
