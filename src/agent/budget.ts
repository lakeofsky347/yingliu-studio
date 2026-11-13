import type { Budget, ToolRisk, Usage } from './tool-contracts.ts';

export const DEFAULT_BUDGET: Budget = { maxSteps: 24, maxToolCalls: 60, maxTokens: 400_000, maxCost: null, currency: 'CNY' };
export function budgetFrom(input: Partial<Budget> = {}): Budget {
  const pick = (value: unknown, fallback: number, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fallback;
  const cost = input.maxCost === null || input.maxCost === undefined ? null : Number(input.maxCost);
  return {
    maxSteps: pick(input.maxSteps, DEFAULT_BUDGET.maxSteps, 1, 200), maxToolCalls: pick(input.maxToolCalls, DEFAULT_BUDGET.maxToolCalls, 1, 1000),
    maxTokens: pick(input.maxTokens, DEFAULT_BUDGET.maxTokens, 1000, 20_000_000),
    maxCost: cost !== null && Number.isFinite(cost) && cost >= 0 ? cost : null, currency: typeof input.currency === 'string' && input.currency ? input.currency.slice(0, 8) : DEFAULT_BUDGET.currency,
  };
}
export function emptyUsage(currency: string): Usage { return { steps: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cost: 0, unknownCostCalls: 0, currency }; }

/** Price per million tokens from model parameters (pricePerMInput / pricePerMOutput). Unknown → null. */
export function tokenCost(parameters: Record<string, unknown>, input: number, output: number): number | null {
  const a = Number(parameters.pricePerMInput), b = Number(parameters.pricePerMOutput);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) return null;
  return (input * a + output * b) / 1_000_000;
}
export function chargeModel(usage: Usage, input: number, output: number, cost: number | null): void {
  usage.inputTokens += input; usage.outputTokens += output;
  if (cost === null) usage.unknownCostCalls++; else usage.cost += cost;
}
export function chargeTool(usage: Usage, cost: number | null | undefined, risk: ToolRisk): void {
  usage.toolCalls++;
  if (risk === 'cost') { if (cost === null || cost === undefined) usage.unknownCostCalls++; else usage.cost += cost; }
}
/** Returns a reason string when the next step must not proceed. */
export function overBudget(budget: Budget, usage: Usage): string | null {
  if (usage.steps >= budget.maxSteps) return `已达到最大步数 ${budget.maxSteps}`;
  if (usage.toolCalls >= budget.maxToolCalls) return `已达到最大工具调用次数 ${budget.maxToolCalls}`;
  if (usage.inputTokens + usage.outputTokens >= budget.maxTokens) return `已达到 token 上限 ${budget.maxTokens}`;
  if (budget.maxCost !== null && usage.cost >= budget.maxCost) return `已达到费用上限 ${budget.maxCost} ${budget.currency}`;
  return null;
}
/** Whether a tool call may run without a human. Cost with a known estimate that would exceed the ceiling is never auto-approved. */
export function needsApproval(risk: ToolRisk, autoApprove: ToolRisk[], budget: Budget, usage: Usage, estimate: number | null, project?: { maxCost: number | null; spent: number; unknownCostCalls: number; currency: string }): string | null {
  if (risk === 'cost' && project && project.maxCost !== null) {
    if (estimate !== null && project.spent + estimate > project.maxCost) return `预计费用 ${estimate} 将超过项目上限 ${project.maxCost} ${project.currency}（已花 ${project.spent.toFixed(2)}）`;
    if (estimate === null && !autoApprove.includes('cost')) return `会调用收费生成模型（费用未知；项目已花 ${project.spent.toFixed(2)} / 上限 ${project.maxCost} ${project.currency}）`;
    if (estimate === null) return '费用未知，且设置了项目费用上限';
  }
  if (risk === 'cost' && budget.maxCost !== null && estimate !== null && usage.cost + estimate > budget.maxCost) return `预计费用 ${estimate} 将超过上限 ${budget.maxCost} ${budget.currency}`;
  if (autoApprove.includes(risk)) return risk === 'cost' && estimate === null && budget.maxCost !== null ? '费用未知，且设置了费用上限' : null;
  return risk === 'cost' ? (estimate === null ? '会调用收费生成模型（费用未知）' : `会调用收费生成模型（预计 ${estimate} ${budget.currency}）`) : risk === 'export' ? '会导出成片文件' : risk === 'plan' ? '请审阅创作计划（批准后才会保存并按计划执行）' : risk === 'write' ? '会修改工程（可撤销）' : '需要确认';
}

export type ErrorClass = 'retry' | 'conflict' | 'model' | 'fatal';
/** Network/5xx/429 → backoff retry; revision conflict → hand back to model to re-read; validation → model fixes; else fatal. */
export function classify(error: unknown): ErrorClass {
  const code = (error as { code?: unknown })?.code, status = (error as { status?: unknown })?.status, retryable = (error as { retryable?: unknown })?.retryable;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'REVISION_CONFLICT' || /版本冲突|版本已变化/.test(message)) return 'conflict';
  if (retryable === true || status === 429 || (typeof status === 'number' && status >= 500) || /ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|EAI_AGAIN/i.test(message) || (error as Error)?.name === 'TimeoutError') return 'retry';
  if (code === 'APP_SHUTTING_DOWN') return 'fatal';
  return 'model';
}
export function backoff(attempt: number, base = 500): number { return Math.min(8000, base * 2 ** attempt) + Math.floor(Math.random() * base / 2); }
