import { useEffect, useState } from 'react';
import type { VideoProject } from '../shared/types.ts';
import type { Ledger, QcReport, Story, StoryCharacter } from '../agent/story.ts';
import { StudioController } from './controller.ts';

const checkNames: Record<QcReport['issues'][number]['check'], string> = { black: '黑帧/空白', silence: '静音', subtitle: '字幕/配音', duration: '时长', consistency: '一致性' };
const severityNames = { low: '提示', medium: '注意', high: '严重' } as const;

/** Structured rendering of a pending plan_story / plan_shots call so the user reviews a plan, not raw JSON. */
export function PlanReview({ tool, args }: { tool: string; args: string }) {
  let value: Record<string, any>; try { value = JSON.parse(args); } catch { return <pre>{args}</pre>; }
  if (tool === 'plan_story') return <div className="vs-plan-review" aria-label="计划审阅">
    <h4>《{String(value.title ?? '')}》{value.targetSeconds ? ` · ${value.targetSeconds} 秒` : ''}</h4>
    <p>{String(value.logline ?? '')}</p>
    {value.style && <dl className="vs-plan-style">{Object.entries(value.style).filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{({ look: '画风', palette: '配色', typography: '字体', motion: '运动', negative: '避免' } as Record<string, string>)[k] ?? k}</dt><dd>{String(v)}</dd></div>)}</dl>}
    {Array.isArray(value.characters) && value.characters.length > 0 && <ul className="vs-plan-characters">{value.characters.map((c: any, i: number) => <li key={i}><strong>{c.name}</strong>{c.id ? `（${c.id}）` : ''}：{[c.description, ...(c.features ?? [])].filter(Boolean).join('，')}</li>)}</ul>}
  </div>;
  if (tool === 'plan_shots' && Array.isArray(value.shots)) return <table className="vs-plan-shots" aria-label="分镜审阅"><thead><tr><th>#</th><th>景别/运镜</th><th>时长</th><th>画面</th><th>台词</th><th>角色</th></tr></thead>
    <tbody>{value.shots.map((s: any, i: number) => <tr key={i}><td>{i + 1}{s.continueFromPrevious ? ' ↩' : ''}</td><td>{[s.shotType, s.camera].filter(Boolean).join(' · ')}</td><td>{s.durationSeconds}s</td><td>{s.summary}</td><td>{s.dialogue}</td><td>{(s.characters ?? []).join('、')}</td></tr>)}</tbody>
    <tfoot><tr><td colSpan={6}>共 {value.shots.length} 镜，{value.shots.reduce((n: number, s: any) => n + (Number(s.durationSeconds) || 0), 0).toFixed(1)} 秒（↩ 表示承接上一镜尾帧）</td></tr></tfoot></table>;
  return <pre>{args}</pre>;
}

export function StoryPanel({ controller, project }: { controller: StudioController; project: VideoProject }) {
  const [story, setStory] = useState<Story | null>(null), [ledger, setLedger] = useState<Ledger | null>(null), [qc, setQc] = useState<QcReport | null>(null);
  const [draft, setDraft] = useState<StoryCharacter[]>([]), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [cap, setCap] = useState('');
  const images = project.assets.filter(a => a.kind === 'image');
  async function load() {
    const [s, l, q] = await Promise.all([controller.api.call<Story>('story.get', { projectId: project.id }), controller.api.call<Ledger>('agent.ledger', { projectId: project.id }), controller.api.call<{ report: QcReport | null }>('agent.qc.last', { projectId: project.id })]);
    setStory(s); setLedger(l); setQc(q.report); setCap(l.maxCost === null ? '' : String(l.maxCost)); if (!dirty) setDraft(s.characters);
  }
  useEffect(() => { void load().catch(() => {}); const t = setInterval(() => { if (!dirty) void load().catch(() => {}); }, 5000); return () => clearInterval(t); }, [project.id, dirty]);
  async function act(work: () => Promise<unknown>) { setBusy(true); setError(''); try { await work(); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }
  const edit = (i: number, patch: Partial<StoryCharacter>) => { setDraft(list => list.map((c, j) => j === i ? { ...c, ...patch } : c)); setDirty(true); };
  if (!story) return null;
  return <div className="vs-story-panel">
    <section aria-label="创作计划">
      <h4>创作计划 {story.status === 'approved' ? `· 已批准（v${story.version}）` : '· 尚无'}</h4>
      {story.status === 'approved' ? <>
        <p><strong>《{story.title}》</strong>{story.logline}</p>
        <p className="vs-muted">风格：{[story.style.look, story.style.palette, story.style.motion].filter(Boolean).join(' / ') || '未设定'}</p>
        {story.shots.length > 0 && <table className="vs-plan-shots"><thead><tr><th>#</th><th>镜头</th><th>时长</th><th>画面</th><th>角色</th><th>一致性</th></tr></thead>
          <tbody>{story.shots.map((s, i) => { const score = story.consistency[s.shotId ?? s.id]; return <tr key={s.id}><td>{i + 1}{s.continueFromPrevious ? ' ↩' : ''}</td><td>{s.shotId ?? '—'}</td><td>{s.durationSeconds}s</td><td>{s.summary}</td><td>{s.characters.join('、')}</td><td className={score ? (score.score < 75 ? 'is-low' : 'is-ok') : ''} title={score?.notes}>{score ? score.score : '—'}</td></tr>; })}</tbody></table>}
        <button disabled={busy} onClick={() => void act(() => controller.api.call('story.save', { projectId: project.id, expectedVersion: story.version, story: { status: 'empty' } }))}>撤销批准（让智能体重新规划）</button>
      </> : <p className="vs-muted">让智能体做多镜头或有角色的作品时，它会先提交计划给你审批。</p>}
    </section>
    <section aria-label="角色库">
      <h4>角色库</h4>
      {draft.map((c, i) => <div className="vs-character" key={i}>
        <input aria-label="角色 ID" value={c.id} onChange={e => edit(i, { id: e.target.value })} placeholder="ID" />
        <input aria-label="角色名" value={c.name} onChange={e => edit(i, { name: e.target.value })} placeholder="名字" />
        <input aria-label="可见特征" value={c.features.join('，')} onChange={e => edit(i, { features: e.target.value.split(/[，,]/).map(x => x.trim()).filter(Boolean) })} placeholder="特征：短发，红色围巾，圆脸…" />
        <select aria-label="参考图" multiple value={c.referenceAssetIds} onChange={e => edit(i, { referenceAssetIds: [...e.target.selectedOptions].map(o => o.value) })}>{images.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <button onClick={() => { setDraft(list => list.filter((_, j) => j !== i)); setDirty(true); }}>删除</button>
      </div>)}
      <button onClick={() => { setDraft(list => [...list, { id: 'c' + (list.length + 1), name: '', description: '', features: [], referenceAssetIds: [] }]); setDirty(true); }}>添加角色</button>
      <button className="vs-primary" disabled={busy || !dirty} onClick={() => void act(async () => { await controller.api.call('story.save', { projectId: project.id, expectedVersion: story.version, story: { characters: draft } }); setDirty(false); })}>保存角色库</button>
    </section>
    <section aria-label="项目预算">
      <h4>项目预算</h4>
      {ledger && <p>累计花费 {ledger.spent.toFixed(4)} {ledger.currency}{ledger.unknownCostCalls ? `（另有 ${ledger.unknownCostCalls} 次费用未知）` : ''}{ledger.maxCost !== null ? ` / 上限 ${ledger.maxCost}` : ' · 不限'}</p>}
      {ledger && Object.keys(ledger.byTool).length > 0 && <p className="vs-muted">{Object.entries(ledger.byTool).map(([k, v]) => `${k} ×${v.calls}：${v.cost.toFixed(4)}`).join(' · ')}</p>}
      <label>项目费用上限 <input type="number" min={0} step="0.01" placeholder="不限" value={cap} onChange={e => setCap(e.target.value)} /></label>
      <button disabled={busy} onClick={() => void act(() => controller.api.call('agent.budget.set', { projectId: project.id, maxCost: cap === '' ? null : Number(cap) }))}>保存上限</button>
    </section>
    <section aria-label="导出前质检">
      <h4>导出前质检 {qc ? (qc.pass ? '· 通过' : '· 有严重问题') : ''}</h4>
      <button disabled={busy} onClick={() => void act(async () => setQc(await controller.api.call<QcReport>('agent.qc', { projectId: project.id })))}>运行质检</button>
      {qc && <>
        <p className="vs-muted">检查于 {new Date(qc.checkedAt).toLocaleString()}</p>
        {qc.issues.length ? <ul className="vs-qc">{qc.issues.map((issue, i) => <li key={i} className={'is-' + issue.severity}>[{severityNames[issue.severity]}] {checkNames[issue.check]}{issue.shotId ? ` · ${issue.shotId}` : ''}：{issue.message}</li>)}</ul> : <p>未发现问题。</p>}
        {qc.unchecked.length > 0 && <p className="vs-muted">未检查：{qc.unchecked.join('；')}</p>}
      </>}
    </section>
    {error && <p className="vs-error" role="alert">{error}</p>}
  </div>;
}
