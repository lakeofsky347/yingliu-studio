import type { StudioSnapshot, SceneSource, VideoProject } from '../shared/types.ts';
import type { Ledger, QcReport, Story } from './story.ts';

/** Risk tiers: read runs freely; write is revision-checked and undoable; cost/export always need a human by default. */
export type ToolRisk = 'read' | 'write' | 'plan' | 'cost' | 'export';
export type JsonSchema = Record<string, unknown>;

export interface ToolContext {
  runId: string; projectId: string; signal: AbortSignal; port: AgentPort;
  /** Per-project structured plan (story.json) and spend ledger. */
  docs: AgentDocs;
}
export interface AgentDocs {
  story(): Promise<Story>;
  updateStory(change: (story: Story) => Story, expectedVersion?: number): Promise<Story>;
  ledger(): Promise<Ledger>;
  saveQc(report: QcReport): Promise<void>;
}
export interface ToolResult {
  /** Text returned to the model (redacted, size-bounded). */
  content: string;
  /** Optional images (PNG/JPEG bytes) for vision-capable models. */
  images?: { mime: string; bytes: Uint8Array }[];
  /** Reported spend for this call when the provider gives one. */
  cost?: number | null;
  /** When set, the run suspends until this async task reaches a terminal phase. */
  waitFor?: { kind: 'media' | 'workflow'; id: string };
  revision?: number;
}
export interface AgentTool {
  /** Tool only exposed when all these roles are bound. */
  requires?: GenRole[];
  /** Tool only exposed when none of these roles are bound (director fallback). */
  fallbackFor?: GenRole[];
  name: string; description: string; parameters: JsonSchema; risk: ToolRisk;
  /** Estimated spend before running (used by budget gate); null = unknown. */
  estimate?(args: Record<string, unknown>): number | null;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type GenRole = 'image' | 'video' | 'speech' | 'music' | 'sfx' | 'vision';
export interface Capabilities { roles: GenRole[]; director?: string; models?: Partial<Record<GenRole, string>> }
export interface ToolCall { id: string; name: string; arguments: string }
export type AgentMessage =
  | { role: 'system' | 'user'; content: string | AgentContent[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export type AgentContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ModelTurn {
  content: string; toolCalls: ToolCall[]; finish: 'stop' | 'tool_calls' | 'length' | 'other';
  usage: { inputTokens: number; outputTokens: number }; mode: 'tools' | 'plan-json';
}

export interface Budget {
  maxSteps: number; maxToolCalls: number; maxTokens: number;
  /** Spend ceiling in `currency`; null = no monetary ceiling (unknown costs still require approval for cost tools). */
  maxCost: number | null; currency: string;
}
export interface Usage { steps: number; toolCalls: number; inputTokens: number; outputTokens: number; cost: number; unknownCostCalls: number; currency: string }

export interface ApprovalPolicy { autoApprove: ToolRisk[] }
export type RunStatus = 'running' | 'awaiting_approval' | 'waiting_task' | 'paused' | 'complete' | 'failed' | 'cancelled' | 'budget_exceeded';

export interface RunStep {
  index: number; kind: 'model' | 'tool' | 'approval' | 'review' | 'compress';
  status: 'running' | 'complete' | 'failed' | 'pending' | 'rejected' | 'skipped';
  startedAt: string; finishedAt?: string; durationMs?: number;
  tool?: string; callId?: string; risk?: ToolRisk; arguments?: string; summary?: string; error?: string; attempts?: number;
}
export interface PendingApproval { callId: string; tool: string; risk: ToolRisk; arguments: string; reason: string; estimate: number | null }

export interface AgentRun {
  version: 1; id: string; projectId: string; goal: string; status: RunStatus; message: string;
  createdAt: string; updatedAt: string;
  model: { connectionId?: string; model?: string; mode?: 'tools' | 'plan-json' };
  budget: Budget; usage: Usage; policy: ApprovalPolicy;
  messages: AgentMessage[]; steps: RunStep[];
  /** Tool calls from the last assistant turn not yet executed (resumable). */
  queue: ToolCall[];
  pending?: PendingApproval; waiting?: { kind: 'media' | 'workflow'; id: string; callId: string };
  approvedCallIds: string[]; reviewRounds: number; final?: string; error?: string;
  /** Capabilities and tool names active at the latest model step. */
  active?: { roles: GenRole[]; tools: string[]; selfMade: string[] };
}

export interface AgentStartInput {
  projectId: string; goal: string; budget?: Partial<Budget>; autoApprove?: ToolRisk[];
  allowImages?: boolean; maxReviewRounds?: number;
}
export type AgentEvent = { type: 'run'; run: PublicRun } | { type: 'step'; runId: string; step: RunStep } | { type: 'delta'; runId: string; text: string };
export type PublicRun = Omit<AgentRun, 'messages'> & { transcript: { role: string; content: string; tool?: string }[] };

/** Narrow host surface the agent may touch. Never exposes file paths or credentials. */
export interface AgentPort {
  snapshot(projectId: string): Promise<StudioSnapshot>;
  readSource(projectId: string, shotId: string): Promise<SceneSource>;
  saveSource(projectId: string, shotId: string, expectedRevision: number, source: SceneSource): Promise<StudioSnapshot>;
  commit(projectId: string, expectedRevision: number, project: VideoProject, sources: Record<string, SceneSource>, label: string): Promise<StudioSnapshot>;
  route(endpoint: string, payload: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>;
  capture(projectId: string, frame: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string; frame: number; shotId: string }>;
  voice?(projectId: string, shotId: string, text: string, signal: AbortSignal): Promise<{ id: string; name: string }>;
  /** Generate audio with a bound role (speech/music/sfx) and import it as a project asset. */
  generateAudio?(projectId: string, role: 'speech' | 'music' | 'sfx', prompt: string, options: { durationSeconds?: number; signal: AbortSignal }): Promise<{ id: string; name: string; cost?: number | null }>;
  /** Import locally synthesized audio bytes (WAV) as a project asset. */
  importAudio?(projectId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ id: string; name: string }>;
  /** Which generation roles are currently bound (hot: read every step). */
  capabilities?(): Promise<Capabilities>;
  /** Import image bytes (e.g. a captured tail frame) as a project asset. */
  importImage?(projectId: string, name: string, bytes: Uint8Array, mime: string): Promise<{ id: string; name: string }>;
  vision?(prompt: string, images: { mime: string; bytes: Uint8Array }[], signal: AbortSignal): Promise<string>;
}
