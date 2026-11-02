/**
 * サーバーモード（PAW_PUBLIC_URL あり = インターネットから見える）で、
 * 危険な既定値のままの起動を拒む。問題はすべて並べて 1 つの Error にする。
 */
import type { AppConfig } from './config';

export function assertSafeServerConfig(config: AppConfig): void {
  if (!config.publicUrl) return;
  const problems: string[] = [];
  if (config.signup === 'open') problems.push('PAW_SIGNUP=open は使えません（first_user か closed にしてください）');
  if (config.seedDemo) problems.push('PAW_SEED_DEMO が有効です（PAW_SEED_DEMO=0 にしてください）');
  if (config.enableDevRoutes) problems.push('PAW_DEV_ROUTES が有効です（PAW_DEV_ROUTES=0 にしてください）');
  if (config.agentRuntime === 'claude_code') {
    if (!config.claudeCode.restricted) problems.push('PAW_CLAUDE_CODE_RESTRICTED=0 は使えません（1 にしてください）');
    if (!config.claudeCode.detected?.supportsRestricted) problems.push('Claude Code CLI が --restricted に対応していません（`claude update` で更新してください）');
  }
  if (problems.length > 0) {
    throw new Error(`サーバーモードの設定が安全ではないため起動を中止します:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
}
