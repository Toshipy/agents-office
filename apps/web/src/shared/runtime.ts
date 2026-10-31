import type { AgentRuntime } from '@paw/contracts';

export type { AgentRuntime };

/** Claude で実行する Run か（API / Claude Code のどちらでも） */
export const isClaudeRuntime = (rt: AgentRuntime | null | undefined): boolean => rt === 'claude' || rt === 'claude_code';

/** 実行基盤の短い表示名 */
export function runtimeLabel(rt: AgentRuntime | null | undefined): string {
  switch (rt) {
    case 'claude':
      return 'Claude API';
    case 'claude_code':
      return 'Claude Code（サブスク）';
    default:
      return 'シミュレーション';
  }
}

/** オフィス・一覧に付ける小さなタグ（シミュレーションは表示しない） */
export function runtimeTag(rt: AgentRuntime | null | undefined): string | null {
  if (rt === 'claude') return 'Claude API';
  if (rt === 'claude_code') return 'Claude Code';
  return null;
}
