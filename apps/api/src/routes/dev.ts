/**
 * ローカル開発専用ルート（PAW_DEV_ROUTES=0 で無効化）。
 * GitHub シミュレーターは本番と同じ署名付き Webhook 経路を通す。
 */
import type { Hono } from 'hono';
import { SimulateGithubRequest } from '@paw/contracts';
import type { AppEnv, Services } from '../app';
import { audit } from '../services/audit';
import { redeliver, simulateIssue, simulateReview } from '../github/simulator';
import { auth, ownedProject, parseBody } from './helpers';

export function registerDevRoutes(app: Hono<AppEnv>, s: Services) {
  app.post('/v1/dev/github/simulate', async (c) => {
    const a = auth(c);
    const body = await parseBody(c, SimulateGithubRequest);
    let result: object;
    if (body.kind === 'issue') {
      await ownedProject(s, a.workspaceId, body.projectId);
      result = await simulateIssue(s.db, s.config, {
        workspaceId: a.workspaceId,
        projectId: body.projectId,
        action: body.action,
        title: body.title,
        body: body.body,
        labels: body.labels,
        senderLogin: a.username,
      });
    } else if (body.kind === 'review') {
      result = await simulateReview(s.db, s.config, {
        workspaceId: a.workspaceId,
        runId: body.runId,
        state: body.state,
        body: body.body,
        reviewerLogin: a.username,
      });
      await audit(s.db, {
        workspaceId: a.workspaceId,
        actorUserId: a.userId,
        action: `github_review.${body.state}`,
        targetType: 'run',
        targetId: body.runId,
        detail: { simulated: true },
      });
    } else {
      result = await redeliver(s.db, s.config, { workspaceId: a.workspaceId, deliveryId: body.deliveryId });
    }
    // 受信後の Dispatcher 処理を待たずに返す（本番同様の非同期）。テスト容易性のため即時 drain も試みる
    void s.dispatcher.drain();
    return c.json(result);
  });
}
