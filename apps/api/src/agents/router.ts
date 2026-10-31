/**
 * Run ごとの実行基盤（claude / simulated）に応じて Runner を選ぶ。
 */
import type { AgentRunner, StepExecutionContext, StepOutput } from './runner';
import { RunnerError } from './runner';

export class RunnerRouter implements AgentRunner {
  readonly name = 'router';

  constructor(
    private readonly simulated: AgentRunner,
    private readonly claude: AgentRunner | null,
  ) {}

  execute(ctx: StepExecutionContext): Promise<StepOutput> {
    if (ctx.runtime === 'claude') {
      if (!this.claude) throw new RunnerError('Claude 実行基盤が無効です（ANTHROPIC_API_KEY を設定して再起動してください）', 'CLAUDE_UNAVAILABLE', false);
      return this.claude.execute(ctx);
    }
    return this.simulated.execute(ctx);
  }

  async onRunFinished(runId: string, localRepoPath: string | null, branch: string) {
    await this.claude?.onRunFinished?.(runId, localRepoPath, branch);
  }
}
