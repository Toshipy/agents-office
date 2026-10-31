/**
 * 起動時の実行基盤の決定。PAW_AGENT_RUNTIME=auto（既定）のとき:
 *   1. この PC の Claude Code CLI が claude.ai のサブスク等でログイン済み → claude_code（API 課金なし）
 *   2. ANTHROPIC_API_KEY がある → claude（Claude API・従量課金）
 *   3. どちらも無い → simulated
 * サブスクを API キーより優先するのは、利用者の要望（追加の課金を避けたい）による。
 *
 * 調べるのは `claude --version` と `claude auth status`（JSON・ログインしていなければ終了コード 1）だけで、
 * モデルは呼ばない（利用枠を消費しない）。
 */
import { tmpdir } from 'node:os';
import type { AppConfig, ClaudeCodeConfig } from '../../config';
import { run } from './git';
import { claudeCliEnv } from './cliBackend';

/** 使っている CLI オプションのうち、最も新しいもの（--restricted）が入ったバージョン */
export const MIN_CLAUDE_CODE_VERSION = '2.1.248';
/** claude.ai のサブスク（Pro / Max 等）のログイン方法 */
const SUBSCRIPTION_AUTH = new Set(['claude.ai', 'oauth_token']);

export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function probeClaudeCode(bin: string): Promise<NonNullable<ClaudeCodeConfig['detected']>> {
  const opts = { cwd: tmpdir(), timeoutMs: 20_000, env: claudeCliEnv() };
  const v = await run(bin, ['--version'], opts);
  if (v.code !== 0) {
    const notFound = /ENOENT/.test(v.stderr);
    return {
      version: null,
      loggedIn: false,
      authMethod: null,
      subscription: false,
      problem: notFound ? `Claude Code CLI（${bin}）が見つかりません` : `\`${bin} --version\` が失敗しました: ${v.stderr.trim().slice(0, 200)}`,
    };
  }
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
  const s = await run(bin, ['auth', 'status'], opts);
  let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string } = {};
  try {
    status = JSON.parse(s.stdout) as typeof status;
  } catch {
    // 古い CLI は auth status を持たない
  }
  const authMethod = typeof status.authMethod === 'string' ? status.authMethod : null;
  const loggedIn = status.loggedIn === true || (s.code === 0 && authMethod !== null && authMethod !== 'none');
  const subscription = loggedIn && authMethod !== null && SUBSCRIPTION_AUTH.has(authMethod) && (status.apiProvider === undefined || status.apiProvider === 'firstParty');
  let problem: string | null = null;
  if (!version) problem = 'Claude Code のバージョンを判別できません';
  else if (compareVersion(version, MIN_CLAUDE_CODE_VERSION) < 0) problem = `Claude Code ${version} は古いため使えません（${MIN_CLAUDE_CODE_VERSION} 以上が必要。\`claude update\` で更新してください）`;
  else if (!authMethod && s.code !== 0) problem = '`claude auth status` でログイン状態を確認できません（`claude auth login` でログインしてください）';
  else if (!loggedIn) problem = 'Claude Code にログインしていません（`claude auth login` で claude.ai アカウントにログインしてください）';
  else if (!subscription) problem = `Claude Code は API 課金のログイン方法（${authMethod ?? '不明'}）で動いています。サブスクで使うには \`claude auth login\` で claude.ai アカウントにログインしてください`;
  return { version, loggedIn, authMethod, subscription, problem };
}

/** auth status の authMethod を表示用に */
export function authMethodLabel(m: string | null) {
  switch (m) {
    case 'claude.ai':
      return 'claude.ai アカウント（サブスク）';
    case 'oauth_token':
      return 'OAuth トークン（サブスク）';
    case 'api_key':
    case 'api_key_helper':
      return 'API キー（従量課金）';
    case 'third_party':
      return 'クラウド事業者経由';
    case 'none':
    case null:
      return '未ログイン';
    default:
      return m;
  }
}

/** server 起動時に呼ぶ。config.agentRuntime / agentRuntimeReason / claudeCode.detected を確定させる */
export async function resolveAgentRuntime(config: AppConfig): Promise<void> {
  const mode = config.agentRuntimeMode;
  if (mode === 'simulated' || mode === 'claude') return;
  const detected = await probeClaudeCode(config.claudeCode.bin);
  config.claudeCode.detected = detected;
  if (mode === 'claude_code') {
    config.agentRuntime = 'claude_code';
    config.agentRuntimeReason = detected.problem
      ? `PAW_AGENT_RUNTIME=claude-code が指定されていますが、確認で問題が見つかりました: ${detected.problem}`
      : `PAW_AGENT_RUNTIME=claude-code — Claude Code ${detected.version} に ${authMethodLabel(detected.authMethod)} でログイン済み`;
    return;
  }
  // auto
  if (!detected.problem) {
    config.agentRuntime = 'claude_code';
    config.agentRuntimeReason = `Claude Code ${detected.version} に ${authMethodLabel(detected.authMethod)} でログイン済みのため、サブスクの利用枠で実行します（API キーは使いません）`;
    return;
  }
  if (config.agentRuntime === 'claude') {
    config.agentRuntimeReason = `ANTHROPIC_API_KEY が設定されているため Claude API（従量課金）で実行します。Claude Code は使いません: ${detected.problem}`;
    return;
  }
  config.agentRuntime = 'simulated';
  config.agentRuntimeReason = `シミュレーションで動作しています — ${detected.problem}`;
}
