import type { SceneSource, VideoProject } from '../shared/types.ts';

export const AGENT_LIMITS = Object.freeze({ heartbeatMs: 5_000, leaseMs: 30_000, maxDepth: 1, activeChildren: 2, pendingAcceptance: 2, children: 16, modelCalls: 64, toolCalls: 128, activeMs: 30 * 60_000, attempts: 3, rounds: 4, contextChars: 24_000, resultChars: 4_000 });
export type AgentRole = 'director' | 'scene' | 'vision';
export type AgentSessionKind = 'root' | 'team' | 'subagent';
export type AgentTaskStatus = 'queued' | 'preflight' | 'planning' | 'executing' | 'validating' | 'committing' | 'reconciling' | 'awaiting-acceptance' | 'awaiting-rebase' | 'paused' | 'blocked' | 'stalled' | 'succeeded' | 'failed' | 'cancelled';
export interface AgentScope { shotIds: string[]; writeFields: string[]; capabilities: string[] }
export interface AgentSession<T = unknown> { id: string; projectId: string; parentSessionId?: string; kind: AgentSessionKind; name: string; version: number; data: T; createdAt: string; updatedAt: string }
export interface CreateAgentSession<T = unknown> { id?: string; kind?: AgentSessionKind; parentSessionId?: string; name?: string; data?: T }
export interface CreateAgentTask { id?: string; operationId?: string; sessionId: string; parentTaskId?: string; goal: string; role?: AgentRole; scope: AgentScope; dependencies?: string[]; acceptance?: string[]; modelSnapshot?: unknown; data?: Record<string, unknown> }
export interface AgentTask extends CreateAgentTask { id: string; operationId: string; projectId: string; rootTaskId: string; role: AgentRole; status: AgentTaskStatus; generation: number; attempts: number; version: number; leaseOwner?: string; leaseExpiresAt?: number; committedRevision?: number; candidateId?: string; error?: string; summary?: string; checkpoint?: string; createdAt: string; updatedAt: string }
export interface AgentLease { taskId: string; sessionId: string; projectId: string; leaseOwner: string; generation: number; leaseExpiresAt: number }
export interface AgentControl { sessionId: string; expectedGeneration: number }
export type LeaseToken = AgentLease;
export interface AgentBudget { rootTaskId: string; children: number; modelCalls: number; toolCalls: number; activeMs: number; limits: { children: number; modelCalls: number; toolCalls: number; activeMs: number } }
export interface AgentTaskPatch { data?: Record<string, unknown>; error?: string; summary?: string; checkpoint?: string; candidateId?: string; committedRevision?: number }
export interface AgentCandidatePayload { project: VideoProject; sources: Record<string, SceneSource>; baseRevision: number; readSet?: Record<string, string> }
export interface AgentCandidate { id: string; taskId: string; sessionId: string; projectId: string; generation: number; hash: string; payload: AgentCandidatePayload; summary: string; status: 'submitted' | 'validated' | 'accepted' | 'rejected'; validationId?: string; acceptedBy?: string; createdAt: string }
export interface ValidationReceipt { id: string; candidateHash: string; baseRevision: number; status: 'passed' | 'failed'; checks: { id: string; status: 'passed' | 'failed'; message?: string }[]; frames: { frame: number; sha256: string }[]; createdAt: string; validatorVersion: string }
export interface AgentOperation { id: string; taskId: string; generation: number; payloadHash: string; status: 'pending' | 'complete' | 'failed' | 'unknown'; result?: unknown; error?: string; createdAt: string; updatedAt: string }
export type AgentMessageKind = 'progress' | 'blocked' | 'decision' | 'result';
export interface AgentMessage { id: number; taskId: string; kind: AgentMessageKind; summary: string; details?: unknown; createdAt: string }
export interface AgentEvent { id: number; taskId: string; type: string; payload: unknown; createdAt: string }
export type AgentDecision =
  | { type: 'read'; query: { shotIds?: string[]; fields?: string[]; candidateId?: string; taskId?: string; offset?: number; limit?: number } }
  | { type: 'execute'; tool: 'code' | 'image' | 'video' | 'speech'; shotId?: string; input: Record<string, unknown> }
  | { type: 'submit'; candidate?: AgentCandidatePayload; summary: string; evidence?: unknown }
  | { type: 'blocked'; reason: string };
export interface AgentExecuteResult { summary: string; candidate?: AgentCandidatePayload; artifactRefs?: string[]; evidence?: unknown; remoteTaskId?: string }
export interface AgentRuntimePorts {
  preflight?(task: AgentTask, signal: AbortSignal): Promise<void>;
  context(task: AgentTask, signal: AbortSignal): Promise<unknown>;
  text(input: { task: AgentTask; role: AgentRole; system: string; messages: { role: 'user' | 'assistant'; content: string }[]; signal: AbortSignal }): Promise<string>;
  inspect(task: AgentTask, query: Extract<AgentDecision, { type: 'read' }>['query'], signal: AbortSignal): Promise<unknown>;
  execute(task: AgentTask, action: Extract<AgentDecision, { type: 'execute' }>, operationId: string, lease: AgentLease, signal: AbortSignal): Promise<AgentExecuteResult>;
  validate(task: AgentTask, candidate: AgentCandidate, signal: AbortSignal): Promise<ValidationReceipt>;
}
export interface DelegateAgentInput { parentTaskId: string; parentLease: AgentLease; operationId?: string; mode: 'team' | 'subagent'; sessionId?: string; name?: string; goal: string; role?: AgentRole; scope: AgentScope; dependencies?: string[]; acceptance?: string[]; modelSnapshot?: unknown; data?: Record<string, unknown> }
