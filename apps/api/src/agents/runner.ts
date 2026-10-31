/**
 * Agent Runner インターフェース（基本設計書 8.2 AgentStepInput / AgentStepResult の概念を実装）。
 *
 * ローカル版は SimulatedRunner のみ。OpenAI Agents SDK（Planner/Reviewer）や
 * Codex SDK（Developer/Tester）のアダプターは同じインターフェースで差し替える想定（ADR-007/008）。
 * Runner は自分の権限を増やせず、ツール呼び出しは必ず ctx.tool() 経由で Tool Broker の判定を受ける。
 */
import type { StepKey, StepRole } from '@paw/contracts';
import type { ArtifactKind, ArtifactRow } from '../workflow/artifactStore';

export interface StepExecutionContext {
  runId: string;
  stepId: string;
  workspaceId: string;
  projectId: string;
  role: StepRole;
  key: StepKey;
  attempt: number;
  revision: number;
  title: string;
  /** 依頼本文（Issue 本文を含む）。非信頼入力として扱う */
  request: string;
  guidance: string | null;
  repo: string | null;
  branch: string;
  fixLoops: number;
  /** 直前までの成果（plan / diff / test 等）。エンジンが検証済みのものだけを渡す */
  previous: Record<string, unknown>;
  pr: { number: number; url: string; branch: string; headSha: string } | null;
  signal: AbortSignal;
  log(message: string, kind?: 'log' | 'error'): Promise<void>;
  /** Tool Broker を通したツール呼び出し。拒否されても例外は投げず結果を返す */
  tool(tool: string, args: Record<string, unknown>, summary: string): Promise<{ allowed: boolean; reason: string }>;
  sleep(ms: number): Promise<void>;
  artifact(kind: ArtifactKind, title: string, filename: string, mediaType: string, content: string): Promise<ArtifactRow>;
  usage(model: string, inputTokens: number, outputTokens: number, durationMs: number): Promise<void>;
  allocatePrNumber(): Promise<number>;
}

export interface StepOutput {
  status: 'succeeded' | 'failed';
  summary: string;
  outcome: Record<string, unknown>;
  errorCode?: string;
}

export interface AgentRunner {
  readonly name: string;
  execute(ctx: StepExecutionContext): Promise<StepOutput>;
}

export class RunnerCrashError extends Error {
  readonly code = 'RUNNER_CRASHED';
}
