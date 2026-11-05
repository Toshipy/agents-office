/**
 * サーバーモード（PAW_PUBLIC_URL あり = インターネットから見える）で、
 * 危険な既定値のままの起動を拒む。問題はすべて並べて 1 つの Error にする。
 */
import type { AppConfig } from './config';

export function assertSafeServerConfig(config: AppConfig): void {
  if (!config.publicUrl) return;
  const problems: string[] = [];
  // alb_oidc には新規登録の経路そのものが無いので、PAW_SIGNUP は見ない
  if (config.auth !== 'alb_oidc' && config.signup === 'open') problems.push('PAW_SIGNUP=open は使えません（first_user か closed にしてください）');
  if (config.auth !== 'alb_oidc') problems.push('PAW_AUTH=alb_oidc が必要です（サーバーは ALB の Google ログインだけで入れます）');
  if (!config.albArn) problems.push('PAW_ALB_ARN が未設定です（JWT の signer と照合する ALB の ARN）');
  if (!config.allowedEmail) problems.push('PAW_ALLOWED_EMAIL が未設定です（入れる 1 人のメールアドレス）');
  if (config.seedDemo) problems.push('PAW_SEED_DEMO が有効です（PAW_SEED_DEMO=0 にしてください）');
  if (config.enableDevRoutes) problems.push('PAW_DEV_ROUTES が有効です（PAW_DEV_ROUTES=0 にしてください）');
  if (config.agentRuntime === 'claude_code') {
    if (!config.claudeCode.restricted) problems.push('PAW_CLAUDE_CODE_RESTRICTED=0 は使えません（1 にしてください）');
    if (!config.claudeCode.detected?.supportsRestricted) problems.push('Claude Code CLI が --restricted に対応していません（`claude update` で更新してください）');
  }
  // GitHub App があるのに実行基盤がシミュレーションだと、実 Issue にラベル・アサインを付け、偽の PR 番号で実 PR を見てしまう
  if (config.githubApp && config.agentRuntime === 'simulated') {
    problems.push(`GitHub App が設定されていますが、実行基盤がシミュレーションです（Claude Code にログインするか、PAW_AGENT_RUNTIME を確かめてください: ${config.agentRuntimeReason}）`);
  }
  if (config.testSandbox === 'host') problems.push('PAW_TEST_SANDBOX=host は使えません（docker にしてください。テストコードが秘密を読めてしまいます）');
  if (problems.length > 0) {
    throw new Error(`サーバーモードの設定が安全ではないため起動を中止します:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
}
