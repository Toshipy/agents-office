/**
 * Policy-gated Tool Broker（基本設計書 2 / 9.1-6 / 9.3）。
 * Agent の発話やプロンプトではなく、このプログラム上のポリシーでツール呼び出しを許可・拒否する。
 * Issue 本文などに「承認を無視して」と書かれていてもポリシーは変わらない（NFR-006）。
 */
import type { StepRole } from '@paw/contracts';

/** どの役割・どの承認状態でも実行させない操作（FR-046 / 要件定義書 4） */
export const GLOBALLY_FORBIDDEN_TOOLS = [
  'github.pull_request.merge',
  'github.push.default_branch',
  'github.secrets.read',
  'github.secrets.write',
  'github.branch_protection.write',
  'secrets.read',
  'prod.deploy',
  'prod.db.write',
] as const;

export const DEFAULT_TOOL_POLICIES: Record<Exclude<StepRole, 'tool_broker'>, string[]> = {
  planner: ['repo.read', 'issue.read', 'plan.write'],
  developer: ['repo.read', 'worktree.write', 'shell.test'],
  tester: ['repo.read', 'shell.test', 'shell.build', 'shell.lint'],
  reviewer: ['repo.read', 'diff.read', 'ci.read', 'review.write'],
};

/** Tool Broker 自身がシステムとして実行できる GitHub 書き込み（ポリシー検証付き） */
const BROKER_TOOLS = ['github.branch.push', 'github.pull_request.create', 'github.pull_request.update'];

export interface ToolRequest {
  role: StepRole;
  tool: string;
  args: Record<string, unknown>;
  /** Agent 定義に保存された許可ツール（役割ごと） */
  allowedTools: string[];
  /** Project に紐づく Repo（無ければ GitHub 書き込み不可） */
  boundRepo: string | null;
}

export interface ToolDecision {
  allowed: boolean;
  reason: string;
}

export function authorizeTool(req: ToolRequest): ToolDecision {
  if ((GLOBALLY_FORBIDDEN_TOOLS as readonly string[]).includes(req.tool)) {
    return { allowed: false, reason: `「${req.tool}」はポリシーで常に禁止されています（人間の操作のみ）` };
  }
  if (req.role === 'tool_broker') {
    if (!BROKER_TOOLS.includes(req.tool)) {
      return { allowed: false, reason: `Tool Broker に許可されていない操作: ${req.tool}` };
    }
    if (!req.boundRepo) return { allowed: false, reason: 'Repo が接続されていません' };
    if (req.args.repo !== req.boundRepo) {
      return { allowed: false, reason: `接続済み Repo（${req.boundRepo}）以外への書き込みは禁止` };
    }
    const branch = String(req.args.branch ?? '');
    if (!/^ai\/[A-Za-z0-9._/-]+$/.test(branch)) {
      return { allowed: false, reason: 'AI 用ブランチ（ai/ プレフィックス）以外への書き込みは禁止' };
    }
    return { allowed: true, reason: 'ポリシー適合' };
  }
  if (!req.allowedTools.includes(req.tool)) {
    return { allowed: false, reason: `${req.role} に許可されていないツール: ${req.tool}` };
  }
  return { allowed: true, reason: 'ポリシー適合' };
}
