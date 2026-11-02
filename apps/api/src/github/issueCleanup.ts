/**
 * 失敗・中止で終わった Run の GitHub を片付ける。
 *  - agents-office ラベルを外す（残すとポーリングが同じ Issue をまた始めてしまう）
 *  - 着手時に自分をアサインしていた（source.assignedBySelf）なら、そのアサインを外して他の人に Issue が空いたと分かるようにする
 * 失敗・中止の理由は Issue に書かない（コメントは投稿しない）。承認なしで行ってよいのはこの 2 つの取り外しだけ。
 * GitHub の失敗はログだけ残して投げない（Run の終わりの処理を止めない）。
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { repositoryBindings, type runs } from '../db/schema';
import { log } from '../lib/logger';
import type { GithubApp } from './app';
import { AGENTS_OFFICE_LABEL } from './labels';

type RunRow = typeof runs.$inferSelect;

export class IssueCleanup {
  constructor(
    private readonly db: Db,
    private readonly github: GithubApp,
    /** 自分の GitHub ログイン名（PAW_GITHUB_LOGIN） */
    private readonly login: string | null,
  ) {}

  async onAbandoned(run: RunRow): Promise<void> {
    const issue = run.source.issueNumber;
    if (run.source.type !== 'github_issue' || !issue) return;
    try {
      const [binding] = await this.db.select().from(repositoryBindings).where(eq(repositoryBindings.projectId, run.projectId));
      if (!binding || binding.verification !== 'github_app') return;
      // 片方が失敗しても、もう片方は試す
      try {
        await this.github.removeLabel(binding.installationId, binding.fullName, issue, AGENTS_OFFICE_LABEL);
      } catch (err) {
        log.warn('issue cleanup: label removal failed', { runId: run.id, issue, err: String(err) });
      }
      if (run.source.assignedBySelf === true && this.login) {
        try {
          await this.github.removeAssignees(binding.installationId, binding.fullName, issue, [this.login]);
        } catch (err) {
          log.warn('issue cleanup: unassign failed', { runId: run.id, issue, err: String(err) });
        }
      }
    } catch (err) {
      log.warn('issue cleanup failed', { runId: run.id, issue, err: String(err) });
    }
  }
}
