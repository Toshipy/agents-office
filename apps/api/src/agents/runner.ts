/**
 * Agent Runner インターフェース（基本設計書 8.2 AgentStepInput / AgentStepResult の概念を実装）。
 *
 * ローカル版は SimulatedRunner のみ。実行基盤の候補は
 *   - Planner / Reviewer: Claude Agent SDK または OpenAI Agents SDK（ADR-007）
 *   - Developer / Tester: Claude Code（Claude Agent SDK）または Codex SDK（ADR-008）
 * で、いずれも同じインターフェースのアダプターとして差し替える（要求定義書 7-7「選択可能性」）。
 * Runner は自分の権限を増やせず、ツール呼び出しは必ず ctx.tool() 経由で Tool Broker の判定を受ける。
 */
import type { AgentRuntime, StepKey, StepRole, UsageMeasurement } from '@paw/contracts';
import type { ArtifactKind, ArtifactRow } from '../workflow/artifactStore';
import type { RemoteRepo } from '../github/repoHost';

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
  /** 画面で任せたときの追加指示（信頼できる指示）。guidance と違い、危険操作・要件確認の停止を外さない */
  extraInstruction: string | null;
  repo: string | null;
  branch: string;
  fixLoops: number;
  /** 直前までの成果（plan / diff / test 等）。エンジンが検証済みのものだけを渡す */
  previous: Record<string, unknown>;
  pr: { number: number; url: string; branch: string; headSha: string } | null;
  /** この Run の実行基盤（Run 作成時に確定） */
  runtime: AgentRuntime;
  /** Project に設定されたローカル git リポジトリ（Claude 実行時に使用。GitHub 連携時はサーバー上の管理クローン） */
  localRepo: { path: string; testCommand: string | null; testImage: string | null } | null;
  /** GitHub App で接続したリポジトリ（push と Draft PR 作成に使う）。ローカル / シミュレーターの Repo は null */
  remote: RemoteRepo | null;
  /** GitHub Issue から起動した Run の Issue 番号 */
  issueNumber: number | null;
  signal: AbortSignal;
  log(message: string, kind?: 'log' | 'error'): Promise<void>;
  /** Tool Broker を通したツール呼び出し。拒否されても例外は投げず結果を返す */
  tool(tool: string, args: Record<string, unknown>, summary: string): Promise<{ allowed: boolean; reason: string }>;
  sleep(ms: number): Promise<void>;
  artifact(kind: ArtifactKind, title: string, filename: string, mediaType: string, content: string): Promise<ArtifactRow>;
  /** 利用量を記録。costUsd を渡さない場合はシミュレーション単価で推定する */
  usage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    extra?: { costUsd?: number; measurement?: UsageMeasurement },
  ): Promise<void>;
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
  /** Run が終端状態になったときの後始末（worktree の削除など） */
  onRunFinished?(runId: string, localRepoPath: string | null, branch: string): Promise<void>;
}

export class RunnerCrashError extends Error {
  readonly code = 'RUNNER_CRASHED';
}

/** エラーコードと再試行可否を明示する失敗 */
export class RunnerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * サブスク（Claude Code）の利用上限に達した。再試行しても上限が戻るまで成功しないため、
 * エンジンは Run を needs_input にして工程を一時停止し、人の「続行」でその工程から再開する。
 */
export class UsageLimitError extends RunnerError {
  constructor(
    message: string,
    /** 上限がリセットされる予定時刻（ISO 8601）。CLI が返さない場合は null */
    readonly resetsAt: string | null,
  ) {
    super(message, 'CLAUDE_USAGE_LIMIT', false);
  }
}

/** publish 承認で人に見せる PR の中身（AI レビューが通った時点の worktree から作る） */
export interface PublishPreview {
  headSha: string;
  /** base からの差分（patch）の SHA-256（16 進） */
  diffSha256: string;
  title: string;
  body: string;
}

/**
 * PR の工程で、worktree の HEAD が人の承認した headSha と違った。承認していない内容は push しない。
 * エンジンは Run を失敗にせず、今の HEAD でテスト → AI レビューからやり直し、通れば publish 承認を作り直す。
 */
export class PublishStaleError extends RunnerError {
  constructor(message: string) {
    super(message, 'PUBLISH_STALE', false);
  }
}
