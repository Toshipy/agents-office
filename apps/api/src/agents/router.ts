/**
 * Run ごとの実行基盤（claude / claude_code / simulated）に応じて Runner を選ぶ。
 * 実行基盤は Run 作成時に確定し、途中で切り替えない。
 */
import type { AgentRunner, StepExecutionContext, StepOutput } from './runner';
import { RunnerError } from './runner';

export class RunnerRouter implements AgentRunner {
  readonly name = 'router';

  constructor(
    private readonly simulated: AgentRunner,
    private readonly claude: { api: AgentRunner | null; code: AgentRunner | null },
    /** worktree の片付け。実行基盤の設定を変えて再起動した後でも、以前の Claude Run を片付けられるよう常に持つ */
    private readonly cleanup: ((runId: string, localRepoPath: string, branch: string) => Promise<void>) | null = null,
  ) {}

  execute(ctx: StepExecutionContext): Promise<StepOutput> {
    if (ctx.runtime === 'claude') {
      if (!this.claude.api) throw new RunnerError('Claude API の実行基盤が無効です（PAW_AGENT_RUNTIME=claude と ANTHROPIC_API_KEY を設定して再起動してください）', 'CLAUDE_UNAVAILABLE', false);
      return this.claude.api.execute(ctx);
    }
    if (ctx.runtime === 'claude_code') {
      if (!this.claude.code) throw new RunnerError('Claude Code の実行基盤が無効です（PAW_AGENT_RUNTIME=claude-code を設定して再起動してください）', 'CLAUDE_UNAVAILABLE', false);
      return this.claude.code.execute(ctx);
    }
    return this.simulated.execute(ctx);
  }

  async onRunFinished(runId: string, localRepoPath: string | null, branch: string) {
    if (!localRepoPath || !this.cleanup) return;
    await this.cleanup(runId, localRepoPath, branch);
  }
}
