import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentRun } from './tool-contracts.ts';

const SAFE = /^[a-zA-Z0-9-]{1,80}$/;
/** Durable agent runs: atomic JSON snapshot per run + append-only JSONL trace. Writes are serialized. */
export class RunStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private readonly redact: (text: string) => Promise<string> = async text => text) {}
  private path(id: string, suffix: string) { if (!SAFE.test(id)) throw new Error('运行 ID 无效'); return join(this.directory, id + suffix); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next; }
  save(run: AgentRun): Promise<void> {
    const copy = JSON.stringify(run, null, 1);
    return this.serial(async () => {
      await mkdir(this.directory, { recursive: true });
      const file = this.path(run.id, '.json'), temporary = file + '.tmp-' + randomUUID();
      try { await writeFile(temporary, await this.redact(copy)); await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
    });
  }
  trace(runId: string, event: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    return this.serial(async () => { await mkdir(this.directory, { recursive: true }); await appendFile(this.path(runId, '.trace.jsonl'), (await this.redact(line)).slice(0, 64_000) + '\n'); });
  }
  async readTrace(runId: string): Promise<Record<string, unknown>[]> {
    await this.queue;
    try { return (await readFile(this.path(runId, '.trace.jsonl'), 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
    catch { return []; }
  }
  async loadAll(): Promise<AgentRun[]> {
    await mkdir(this.directory, { recursive: true });
    const runs: AgentRun[] = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue;
      try { const run = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as AgentRun; if (run.version === 1 && SAFE.test(run.id) && name === run.id + '.json') runs.push(run); } catch { /* skip corrupt */ }
    }
    return runs;
  }
}
