import type { AgentTask, AgentTaskStatus } from '../agent/contracts.ts';

/** Only transport retries of an unfinished request reuse its operation identity. */
export class PendingOperationRequests {
  private pending = new Map<string, string>();
  prepare(endpoint: string, payload: Record<string, unknown>): { key: string; payload: Record<string, unknown> } {
    const key = endpoint + '\n' + JSON.stringify(payload);
    const operationId = typeof payload.operationId === 'string' ? payload.operationId : this.pending.get(key) ?? crypto.randomUUID();
    this.pending.set(key, operationId);
    return { key, payload: { ...payload, operationId } };
  }
  complete(key: string): void { this.pending.delete(key); }
}

/** A request from one conversation must never occupy or complete another one. */
export class SessionRequests {
  private requests = new Map<string, string>();
  begin(sessionId: string): string {
    if (this.requests.has(sessionId)) throw new Error('当前对话已有请求进行中');
    const token = crypto.randomUUID(); this.requests.set(sessionId, token); return token;
  }
  pending(sessionId: string): boolean { return this.requests.has(sessionId); }
  finish(sessionId: string, token: string): boolean {
    if (this.requests.get(sessionId) !== token) return false;
    this.requests.delete(sessionId); return true;
  }
}

export const agentPhaseLabels: Record<AgentTaskStatus, string> = {
  queued: '等待执行', preflight: '检查制作条件', planning: '规划中', executing: '制作中', validating: '检查结果',
  committing: '保存结果', reconciling: '确认执行结果', 'awaiting-acceptance': '等待验收', 'awaiting-rebase': '工程已变化，等待复核',
  paused: '已暂停', blocked: '需要处理', stalled: '暂无有效进展', succeeded: '已完成', failed: '未完成', cancelled: '已取消',
};
export const agentActivePhases = new Set<AgentTaskStatus>(['queued', 'preflight', 'planning', 'executing', 'validating', 'committing', 'reconciling']);
export function recoveryLabel(task: Pick<AgentTask, 'status' | 'committedRevision' | 'checkpoint'>): string {
  if (task.committedRevision !== undefined || task.checkpoint === 'needs-validation') return '重新验证已保存结果';
  if (task.status === 'awaiting-rebase') return '复核冲突后继续';
  if (task.status === 'paused') return '继续未完成步骤';
  return '修复失败步骤';
}
