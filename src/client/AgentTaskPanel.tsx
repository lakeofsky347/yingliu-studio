import { useEffect, useState } from 'react';
import type { AgentBudget, AgentTask } from '../agent/contracts.ts';
import type { StudioSnapshot } from '../shared/types.ts';
import type { StudioController } from './controller.ts';
import { agentActivePhases, agentPhaseLabels, recoveryLabel } from './agent-client.ts';
import { errorMessage } from './ui.tsx';

type TaskList = { tasks: AgentTask[]; budgets?: Record<string, AgentBudget> };
const roleNames = { director: '导演', scene: '画面', vision: '审片' };
const recoverable = new Set(['paused', 'blocked', 'stalled', 'failed', 'awaiting-rebase']);

export function AgentTaskPanel({ controller, sessionId, projectId }: { controller: StudioController; sessionId: string; projectId?: string }) {
  const [records, setRecords] = useState<TaskList>({ tasks: [] }), [error, setError] = useState(''), [working, setWorking] = useState(''), [serial, setSerial] = useState(0);
  useEffect(() => {
    let active = true, reading = false;
    setRecords({ tasks: [] }); setError(''); setWorking('');
    async function refresh() {
      if (reading) return; reading = true;
      try {
        const value = await controller.api.call<TaskList>('agent.tasks', { sessionId, projectId });
        if (active) { setRecords(value); setError(''); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { reading = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 1200);
    return () => { active = false; clearInterval(timer); };
  }, [controller, sessionId, projectId, serial]);

  async function change(task: AgentTask, action: 'pause' | 'resume' | 'retry' | 'cancel') {
    setWorking(task.id); setError('');
    try {
      let expectedRevision: number | null = null;
      if (action === 'resume' || action === 'retry') {
        await controller.flush();
        if (controller.hasUnsavedChanges) throw new Error('请保存或处理当前草稿后继续任务。');
        if (projectId) {
          const snapshot = await controller.api.call<StudioSnapshot>('current', { projectId });
          if (snapshot.project?.id !== projectId) throw new Error('无法读取任务对应的工程，请刷新后继续。');
          expectedRevision = snapshot.project.revision;
        }
      }
      await controller.mutation(`agent.task.${action}`, { sessionId, projectId, taskId: task.id, generation: task.generation, ...(['resume', 'retry'].includes(action) ? { expectedRevision } : {}) });
      if (['resume', 'retry'].includes(action) && controller.getSnapshot().agentSessionId === sessionId && controller.getSnapshot().snapshot?.project?.id === projectId) await controller.refreshMediaProject();
      if (controller.getSnapshot().agentSessionId === sessionId) setSerial(value => value + 1);
    } catch (cause) { if (controller.getSnapshot().agentSessionId === sessionId) setError(errorMessage(cause)); }
    finally { if (controller.getSnapshot().agentSessionId === sessionId) setWorking(''); }
  }
  const roots = records.tasks.filter(task => !task.parentTaskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = roots[0], pending = records.tasks.filter(task => task.status === 'awaiting-acceptance').length;
  if (!records.tasks.length && !error) return null;
  return <details className="yl-agent-tasks" open={!!latest && !['succeeded', 'cancelled'].includes(latest.status)}>
    <summary><span>制作进度{latest ? ` · ${agentPhaseLabels[latest.status]}` : ''}</span>{pending > 0 && <small>{pending} 项待验收</small>}</summary>
    {error && <p className="yl-error" role="alert">{error}</p>}
    <div className="yl-agent-task-scroll">
      {roots.slice(0, 4).map(root => {
        const budget = records.budgets?.[root.rootTaskId], children = records.tasks.filter(task => task.parentTaskId === root.id);
        return <article className="yl-agent-root" key={root.id} data-agent-task-id={root.id}>
          <p className="yl-agent-goal">{root.goal}</p><strong className="yl-agent-phase">{agentPhaseLabels[root.status]}</strong>
          {root.error && <p className="yl-agent-reason">{root.error}</p>}
          {root.summary && <p className="yl-agent-summary">{root.summary}</p>}
          {budget && <p className="yl-agent-budget">剩余：{Math.max(0, budget.limits.modelCalls - budget.modelCalls)} 次模型请求 · {Math.max(0, budget.limits.toolCalls - budget.toolCalls)} 次操作 · {Math.max(0, Math.ceil((budget.limits.activeMs - budget.activeMs) / 60000))} 分钟 · {Math.max(0, budget.limits.children - budget.children)} 个协作任务</p>}
          {children.length > 0 && <ul className="yl-agent-children">{children.map(child => <li key={child.id} data-agent-task-id={child.id}><div><strong>{roleNames[child.role]} · {child.goal}</strong><span>{agentPhaseLabels[child.status]}</span></div>{child.error && <p>{child.error}</p>}{child.summary && <small>{child.summary}</small>}</li>)}</ul>}
          <div className="yl-agent-actions">
            {agentActivePhases.has(root.status) && <button disabled={!!working} onClick={() => void change(root, 'pause')}>暂停任务</button>}
            {recoverable.has(root.status) && <button disabled={!!working} onClick={() => void change(root, root.status === 'paused' ? 'resume' : 'retry')}>{recoveryLabel(root)}</button>}
            {!['succeeded', 'cancelled'].includes(root.status) && <button disabled={!!working} onClick={() => void change(root, 'cancel')}>{working === root.id ? '处理中…' : '取消任务'}</button>}
          </div>
        </article>;
      })}
    </div>
  </details>;
}
