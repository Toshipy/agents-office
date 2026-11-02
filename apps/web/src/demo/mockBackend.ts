/**
 * ブラウザ内デモ用のモックバックエンド。
 * 本物の API（apps/api）と同じレスポンス形式で /v1/* を返し、EventSource を差し替えて
 * イベントを配信する。Run の進行は実 API のワークフローエンジンを簡略化したシミュレーション。
 * 3D 表示状態の投影は実 API と同じ @paw/office-model を使う。
 */
import {
  ACTIVE_RUN_STATUSES,
  AGENT_ROLES,
  TERMINAL_RUN_STATUSES,
  type AgentRole,
  type ApprovalActionType,
  type ApprovalStatus,
  type EventType,
  type OfficeState,
  type RunStatus,
  type RunSummary,
  type SeatViewModel,
  type StepKey,
  type StepLogLine,
  type StepRole,
  type StepStatus,
  type WorkspaceEvent,
} from '@paw/contracts';
import { buildProjectStats, buildSeats, runProgress, type ProjectionInput } from '@paw/office-model';
import {
  PATTERNS,
  detectDangerous,
  draftPrMarkdown,
  generateDiff,
  planMarkdown,
  reviewMarkdown,
  seededRandom,
  sha256Hex,
  testReport,
  type ContentContext,
} from '@paw/sim-content';

/* ------------------------------------------------------------------ */
/* model                                                               */
/* ------------------------------------------------------------------ */

interface MProject {
  id: string;
  name: string;
  description: string;
  color: string;
  position: number;
  repo: string;
  automation: boolean;
  triggerLabel: string;
  maxRevisionAttempts: number;
  nextPr: number;
  nextIssue: number;
}
interface MRun {
  id: string;
  projectId: string;
  title: string;
  request: string;
  status: RunStatus;
  statusVersion: number;
  source: { type: 'manual' | 'github_issue'; issueNumber?: number };
  plan: { steps: { id: string; role: string; dependsOn: string[] }[]; flags: string[]; summary: string } | null;
  guidance: string | null;
  revisionCount: number;
  maxRevisionAttempts: number;
  fixLoops: number;
  costUsd: number;
  pr: { number: number; url: string; branch: string; headSha: string; draft: boolean } | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  autoReviewAt?: number;
}
interface MStep {
  id: string;
  runId: string;
  seq: number;
  key: StepKey;
  role: StepRole;
  status: StepStatus;
  attempt: number;
  revision: number;
  summary: string | null;
  errorCode: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  duration: number;
  script: { at: number; kind: StepLogLine['kind']; message: string }[];
  emitted: number;
  outcome: Record<string, unknown>;
  inTok: number;
  outTok: number;
}
interface MApproval {
  id: string;
  runId: string;
  projectId: string;
  actionType: ApprovalActionType;
  requestedByRole: AgentRole;
  title: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  status: ApprovalStatus;
  version: number;
  expiresAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionComment: string | null;
  createdAt: number;
}
interface MArtifact {
  id: string;
  runId: string;
  stepId: string | null;
  kind: 'plan' | 'diff' | 'test_report' | 'review' | 'draft_pr';
  title: string;
  mediaType: string;
  content: string;
  createdAt: number;
}

const WS = 'ws_demo';
const USER = { id: 'usr_demo', username: 'you', displayName: 'あなた' };
const AGENTS = [
  { id: 'agt_planner', role: 'planner' as const, name: 'Sora', runtime: 'Claude Agent SDK / OpenAI Agents SDK（候補・未接続 → シミュレーション）', tools: ['repo.read', 'issue.read', 'plan.write'] },
  { id: 'agt_developer', role: 'developer' as const, name: 'Ren', runtime: 'Claude Code / Codex SDK（候補・未接続 → シミュレーション）', tools: ['repo.read', 'worktree.write', 'shell.test'] },
  { id: 'agt_tester', role: 'tester' as const, name: 'Mio', runtime: '検証コマンド（未接続 → シミュレーション）', tools: ['repo.read', 'shell.test', 'shell.build', 'shell.lint'] },
  { id: 'agt_reviewer', role: 'reviewer' as const, name: 'Kei', runtime: 'Claude Agent SDK / OpenAI Agents SDK（候補・未接続 → シミュレーション）', tools: ['repo.read', 'diff.read', 'ci.read', 'review.write'] },
];
const PRICE = { input: 3, output: 12 };
const TOKENS: Record<StepKey, [number, number]> = {
  plan: [4200, 1100],
  implement: [12500, 4200],
  test: [2600, 500],
  review: [8200, 1500],
  draft_pr: [0, 0],
  update_pr: [0, 0],
};
const DURATION: Record<StepKey, number> = { plan: 6500, implement: 11000, test: 7500, review: 6500, draft_pr: 2600, update_pr: 2400 };

let idSeq = 0;
const nid = (p: string) => `${p}_${(++idSeq).toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

class DemoServer {
  projects: MProject[] = [];
  runs: MRun[] = [];
  steps: MStep[] = [];
  approvals: MApproval[] = [];
  artifacts: MArtifact[] = [];
  logs: StepLogLine[] = [];
  events: WorkspaceEvent[] = [];
  audit: { id: string; action: string; targetType: string; targetId: string | null; detail: Record<string, unknown>; createdAt: string }[] = [];
  usage: { runId: string; cost: number; inTok: number; outTok: number; at: number }[] = [];
  settings = { monthlyBudgetUsd: 200, runBudgetUsd: 2, maxConcurrentRuns: 4, demoTraffic: true, paused: false };
  seq = 0;
  logSeq = 0;
  listeners = new Set<(e: WorkspaceEvent) => void>();
  seatSig = new Map<string, string>();
  nextTraffic = Date.now() + 9000;
  startedAt = Date.now();

  constructor() {
    this.seed();
    window.setInterval(() => this.tick(), 250);
  }

  /* ---------------- events ---------------- */
  emit(type: EventType, data: Record<string, unknown>, runId: string | null = null, projectId: string | null = null) {
    const e: WorkspaceEvent = { eventId: nid('evt'), workspaceId: WS, sequence: ++this.seq, type, occurredAt: new Date().toISOString(), runId, projectId, data };
    this.events.push(e);
    if (this.events.length > 3000) this.events.splice(0, 1000);
    for (const l of this.listeners) l(e);
  }
  emitTransient(line: StepLogLine, projectId: string) {
    const e: WorkspaceEvent = { eventId: nid('tev'), workspaceId: WS, sequence: null, type: 'step.log', occurredAt: line.ts, runId: line.runId, projectId, data: { line } };
    for (const l of this.listeners) l(e);
  }

  /* ---------------- seed ---------------- */
  seed() {
    const defs: [string, string, string, string, boolean][] = [
      ['Storefront Web', 'EC サイトのフロントエンド（React）', '#5eead4', 'you/storefront-web', true],
      ['Billing API', '請求・決済まわりのバックエンド API', '#fb7185', 'you/billing-api', true],
      ['Mobile App', 'iOS / Android アプリ（React Native）', '#a78bfa', 'you/mobile-app', false],
      ['Docs Portal', '開発者向けドキュメントサイト', '#fbbf24', 'you/docs-portal', true],
      ['Data Pipeline', '集計バッチと分析基盤', '#60a5fa', 'you/data-pipeline', false],
    ];
    this.projects = defs.map(([name, description, color, repo, automation], i) => ({
      id: `prj_${i + 1}${name.replace(/\W/g, '').slice(0, 6).toLowerCase()}`,
      name,
      description,
      color,
      position: i,
      repo,
      automation,
      triggerLabel: 'agents-office',
      maxRevisionAttempts: 3,
      nextPr: 40 + i * 7,
      nextIssue: 120 + i * 11,
    }));
    const now = Date.now();
    const hist: [number, string, number, 'completed' | 'waiting_review' | 'failed'][] = [
      [0, '商品詳細ページの画像遅延読み込み', 300, 'completed'],
      [0, 'カート画面のアクセシビリティ改善', 180, 'completed'],
      [1, '請求書 PDF のファイル名規則を変更', 240, 'completed'],
      [1, 'Webhook 受信のリトライ間隔を調整', 26, 'waiting_review'],
      [2, 'プッシュ通知の許可ダイアログ文言修正', 420, 'completed'],
      [3, 'API リファレンスの検索を高速化', 95, 'completed'],
      [4, '日次集計ジョブのタイムゾーン不具合', 60, 'failed'],
    ];
    for (const [pi, title, ago, final] of hist) this.seedHistory(this.projects[pi], title, now - ago * 60_000, final);
    const live: [number, string, string][] = [
      [0, 'ログイン画面のパスワード表示切替', 'ログイン画面のパスワード表示切替を実装し、テストと Draft PR を作成して'],
      [1, 'API にユーザー単位のレート制限を追加', '1 分あたり 120 リクエストを超えたら 429 と Retry-After を返す'],
      [3, 'ドキュメントにダークモードを追加', 'ドキュメントサイトにダークモード切替を追加する'],
      [4, '本番 DB の古いテーブルを削除して集計を高速化', '本番 DB の不要テーブルを drop table して、集計クエリを速くしてほしい'],
    ];
    for (const [pi, title, request] of live) this.createRun(this.projects[pi], title, request, { type: 'manual' }, false);
    this.seq = 0;
    this.events = [];
  }

  seedHistory(p: MProject, title: string, start: number, final: 'completed' | 'waiting_review' | 'failed') {
    const run = this.createRun(p, title, title, { type: 'manual' }, false);
    run.createdAt = start;
    run.startedAt = start + 1000;
    const failed = final === 'failed';
    const keys: StepKey[] = failed ? ['plan', 'implement', 'test'] : ['plan', 'implement', 'test', 'review', 'draft_pr'];
    let t = start + 1000;
    for (const key of keys) {
      const st = this.addStep(run, key);
      st.status = 'succeeded';
      st.attempt = 1;
      st.startedAt = t;
      t += DURATION[key];
      st.finishedAt = t;
      this.completeContent(run, st, key === 'test' ? !failed : true, false);
      st.summary = this.summaryFor(st, run);
      for (const a of this.artifacts) if (a.stepId === st.id) a.createdAt = t;
      const [i, o] = TOKENS[key];
      if (i) {
        const cost = (i * PRICE.input + o * PRICE.output) / 1e6;
        run.costUsd += cost;
        this.usage.push({ runId: run.id, cost, inTok: i, outTok: o, at: t });
      }
    }
    run.status = final;
    run.statusVersion = 8;
    run.updatedAt = t;
    if (failed) {
      run.errorCode = 'TESTS_FAILED';
      run.errorMessage = '自動修正の上限（2 回）に達しました';
      run.finishedAt = t;
      run.fixLoops = 2;
    } else {
      this.createApproval(run, 'pr_review', 'reviewer', `Draft PR #${run.pr?.number} のレビュー`, this.prPayload(run), false);
      const ap = this.approvals[this.approvals.length - 1];
      ap.createdAt = t;
      if (final === 'completed') {
        ap.status = 'approved';
        ap.version = 2;
        ap.decidedBy = 'github:you';
        ap.decidedAt = t + 3600_000;
        run.finishedAt = Math.min(Date.now() - 60_000, t + 3600_000);
        run.updatedAt = run.finishedAt;
      }
    }
  }

  /* ---------------- run lifecycle ---------------- */
  createRun(p: MProject, title: string, request: string, source: MRun['source'], announce = true): MRun {
    const now = Date.now();
    const run: MRun = {
      id: nid('run'),
      projectId: p.id,
      title,
      request,
      status: 'queued',
      statusVersion: 1,
      source,
      plan: null,
      guidance: null,
      revisionCount: 0,
      maxRevisionAttempts: p.maxRevisionAttempts,
      fixLoops: 0,
      costUsd: 0,
      pr: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.runs.unshift(run);
    if (announce) this.emit('run.created', { title, status: 'queued', source: source.type }, run.id, p.id);
    return run;
  }

  transition(run: MRun, to: RunStatus, patch: Partial<MRun> = {}) {
    const from = run.status;
    if (from === to) return;
    Object.assign(run, patch);
    run.status = to;
    run.statusVersion += 1;
    run.updatedAt = Date.now();
    if (to === 'planning' && !run.startedAt) run.startedAt = Date.now();
    const terminal = TERMINAL_RUN_STATUSES.includes(to);
    if (terminal) run.finishedAt = Date.now();
    this.emit('run.status_changed', { from, to, statusVersion: run.statusVersion, errorCode: run.errorCode }, run.id, run.projectId);
    if (terminal) this.emit('run.completed', { status: to, errorCode: run.errorCode, costUsd: run.costUsd }, run.id, run.projectId);
  }

  addStep(run: MRun, key: StepKey): MStep {
    const role: StepRole = key === 'plan' ? 'planner' : key === 'implement' ? 'developer' : key === 'test' ? 'tester' : key === 'review' ? 'reviewer' : 'tool_broker';
    const seq = this.steps.filter((s) => s.runId === run.id).length + 1;
    const rand = seededRandom(`${run.id}:${seq}`);
    const st: MStep = {
      id: nid('stp'),
      runId: run.id,
      seq,
      key,
      role,
      status: 'pending',
      attempt: 0,
      revision: run.revisionCount,
      summary: null,
      errorCode: null,
      startedAt: null,
      finishedAt: null,
      duration: DURATION[key] * (0.8 + rand() * 0.45),
      script: [],
      emitted: 0,
      outcome: {},
      inTok: Math.round(TOKENS[key][0] * (0.8 + rand() * 0.4)),
      outTok: Math.round(TOKENS[key][1] * (0.8 + rand() * 0.4)),
    };
    this.steps.push(st);
    return st;
  }

  ctx(run: MRun): ContentContext {
    const p = this.projects.find((x) => x.id === run.projectId)!;
    return { runId: run.id, title: run.title, request: run.request, repo: p.repo, revision: run.revisionCount, guidance: run.guidance, branch: `ai/run-${run.id.slice(4, 14).toLowerCase()}` };
  }

  buildScript(run: MRun, st: MStep): MStep['script'] {
    const c = this.ctx(run);
    const text = `${run.title}\n${run.request}\n${run.guidance ?? ''}`;
    const lines: [StepLogLine['kind'], string][] = [];
    switch (st.key) {
      case 'plan':
        lines.push(['log', '依頼本文を読み込み（Issue・依頼文は非信頼入力として扱う）'], ['tool', 'issue.read — 依頼内容を取得'], ['tool', `repo.read — リポジトリ構造を参照: src/, tests/, package.json`]);
        if (PATTERNS.injection.test(text)) lines.push(['error', '⚠ 非信頼入力内に指示文を検出 — ポリシーは変更されません']);
        if (detectDangerous(text).length && !run.guidance) lines.push(['error', `危険な操作を検知: ${detectDangerous(text).join(' / ')} — 実行を停止して判断を求めます`]);
        else lines.push(['log', 'Step DAG を構築: plan → implement → test → review → draft_pr'], ['tool', 'plan.write — 計画を保存']);
        break;
      case 'implement': {
        lines.push(['tool', `worktree.write — 隔離 worktree を準備: ${c.branch}`]);
        if (run.revisionCount > 0 && run.guidance) lines.push(['log', `レビューコメントを反映（revision ${run.revisionCount}）: ${run.guidance.slice(0, 60)}`]);
        for (const f of generateDiff(c).files) lines.push(['tool', `worktree.write — 編集: ${f.path} (+${f.additions} −${f.deletions})`]);
        if (PATTERNS.mergeRequest.test(text)) lines.push(['policy', '拒否: github.pull_request.merge — 「github.pull_request.merge」はポリシーで常に禁止されています（人間の操作のみ）']);
        if (PATTERNS.injection.test(text)) lines.push(['policy', '拒否: secrets.read — 「secrets.read」はポリシーで常に禁止されています（人間の操作のみ）']);
        lines.push(['tool', 'shell.test — 型チェック: tsc --noEmit → OK'], ['log', `コミット作成: ${sha256Hex(st.id).slice(0, 7)} on ${c.branch}`]);
        break;
      }
      case 'test':
        lines.push(['tool', 'shell.build — pnpm build'], ['tool', 'shell.lint — pnpm lint → 0 errors'], ['tool', 'shell.test — pnpm test']);
        break;
      case 'review':
        lines.push(['tool', 'diff.read — 差分を取得'], ['tool', 'ci.read — テスト結果を確認'], ['log', '受入条件との照合中…'], ['tool', 'review.write — 指摘: blocker 0 / nit 2']);
        break;
      default:
        lines.push(['tool', `github.branch.push — ブランチを push: ${c.branch}`], ['tool', st.key === 'update_pr' ? `github.pull_request.update — Draft PR #${run.pr?.number} を更新` : 'github.pull_request.create — Draft PR を作成（base: main）']);
    }
    return lines.map(([kind, message], i) => ({ at: ((i + 0.6) / (lines.length + 0.4)) * st.duration, kind, message }));
  }

  startStep(run: MRun, st: MStep) {
    st.status = 'running';
    st.attempt += 1;
    st.startedAt = Date.now();
    st.script = this.buildScript(run, st);
    st.emitted = 0;
    if (st.key === 'implement' && run.status === 'revising') this.transition(run, 'running');
    this.emit('step.started', { stepId: st.id, key: st.key, role: st.role, attempt: st.attempt }, run.id, run.projectId);
  }

  log(run: MRun, st: MStep, kind: StepLogLine['kind'], message: string) {
    const line: StepLogLine = { id: ++this.logSeq, runId: run.id, stepId: st.id, ts: new Date().toISOString(), kind, message };
    this.logs.push(line);
    if (this.logs.length > 6000) this.logs.splice(0, 2000);
    this.emitTransient(line, run.projectId);
    if (kind === 'policy') {
      const tool = message.replace(/^拒否: /, '').split(' — ')[0];
      this.emit('policy.denied', { stepId: st.id, role: st.role, tool, reason: message.split(' — ')[1] ?? '' }, run.id, run.projectId);
    }
  }

  addArtifact(run: MRun, st: MStep, kind: MArtifact['kind'], title: string, mediaType: string, content: string, announce = true) {
    const a: MArtifact = { id: nid('art'), runId: run.id, stepId: st.id, kind, title, mediaType, content, createdAt: Date.now() };
    this.artifacts.push(a);
    if (announce) this.emit('artifact.created', { artifactId: a.id, kind, title }, run.id, run.projectId);
  }

  completeContent(run: MRun, st: MStep, testsPass: boolean, announce = true) {
    const c = this.ctx(run);
    const p = this.projects.find((x) => x.id === run.projectId)!;
    switch (st.key) {
      case 'plan': {
        const steps = [
          { id: 'plan', role: 'planner', dependsOn: [] },
          { id: 'implement', role: 'developer', dependsOn: ['plan'] },
          { id: 'test', role: 'tester', dependsOn: ['implement'] },
          { id: 'review', role: 'reviewer', dependsOn: ['test'] },
          { id: 'draft_pr', role: 'tool_broker', dependsOn: ['review'] },
        ];
        run.plan = { steps, flags: [], summary: run.title };
        this.addArtifact(run, st, 'plan', '実行計画', 'text/markdown', planMarkdown(c, steps, []), announce);
        break;
      }
      case 'implement': {
        const d = generateDiff(c);
        st.outcome = { diff: { files: d.files, additions: d.additions, deletions: d.deletions } };
        this.addArtifact(run, st, 'diff', `差分（revision ${run.revisionCount}）`, 'text/x-diff', d.patch, announce);
        break;
      }
      case 'test': {
        const rep = testReport(c, testsPass, Math.floor(seededRandom(st.id)() * 9999));
        st.outcome = { passed: testsPass, total: rep.total, failed: rep.failed };
        this.addArtifact(run, st, 'test_report', `テスト結果（${testsPass ? '成功' : '失敗'}）`, 'application/json', JSON.stringify(rep, null, 2), announce);
        break;
      }
      case 'review':
        st.outcome = { approved: true, blockers: [] };
        this.addArtifact(run, st, 'review', 'AI レビュー', 'text/markdown', reviewMarkdown(c, generateDiff(c), []), announce);
        break;
      case 'draft_pr':
      case 'update_pr': {
        const update = st.key === 'update_pr' && run.pr !== null;
        const number = update ? run.pr!.number : p.nextPr++;
        run.pr = { number, url: `local-github://${p.repo}/pull/${number}`, branch: c.branch, headSha: sha256Hex(`${st.id}:pr`).slice(0, 40), draft: true };
        st.outcome = { pr: run.pr };
        this.addArtifact(run, st, 'draft_pr', `Draft PR #${number}${update ? '（更新）' : ''}`, 'text/markdown', draftPrMarkdown(c, run.pr, true, update), announce);
        break;
      }
    }
  }

  summaryFor(st: MStep, run: MRun): string {
    switch (st.key) {
      case 'plan':
        return '5 ステップの計画を作成';
      case 'implement': {
        const d = st.outcome.diff as { files: unknown[]; additions: number; deletions: number } | undefined;
        return d ? `${d.files.length} ファイル変更 (+${d.additions} −${d.deletions})` : '実装';
      }
      case 'test':
        return st.outcome.passed ? `${st.outcome.total} 件のテストが通過` : `${st.outcome.failed ?? 1} 件のテストが失敗`;
      case 'review':
        return 'Draft PR 提出可（人間の承認ではない）';
      default:
        return `Draft PR #${run.pr?.number} ${st.key === 'update_pr' ? '更新' : '作成'}`;
    }
  }

  finishStep(run: MRun, st: MStep) {
    while (st.emitted < st.script.length) {
      const s = st.script[st.emitted++];
      this.log(run, st, s.kind, s.message);
    }
    const text = `${run.title}\n${run.request}`;
    if (st.key === 'plan' && detectDangerous(text).length && !run.guidance) {
      st.status = 'succeeded';
      st.finishedAt = Date.now();
      st.summary = `危険な操作（${detectDangerous(text).join('、')}）を含むため停止`;
      this.chargeUsage(run, st);
      this.emit('step.finished', { stepId: st.id, key: st.key, role: st.role, status: 'succeeded', summary: st.summary }, run.id, run.projectId);
      this.transition(run, 'needs_input');
      this.createApproval(run, 'dangerous_operation', 'planner', '危険な操作を含む依頼のため停止', {
        reason: 'dangerous_operation',
        detected: detectDangerous(text),
        questions: ['危険な操作を除外した安全な範囲で実装を進めてよいですか？', '本番環境・Secrets への変更が必要な場合は、人間が別途実施してください。'],
        requestExcerpt: run.request.slice(0, 600),
        note: 'MVP では危険操作は承認しても実行できません。安全な範囲での再計画（差し戻し）か中止を選んでください。',
      });
      return;
    }
    const pass = st.key !== 'test' || run.fixLoops > 0 || run.revisionCount > 0 || seededRandom(`${run.id}:t`)() > 0.22;
    this.completeContent(run, st, pass);
    st.status = 'succeeded';
    st.finishedAt = Date.now();
    st.summary = this.summaryFor(st, run);
    if (st.key === 'test') this.log(run, st, pass ? 'log' : 'error', pass ? `✓ ${st.outcome.total} tests passed` : `✗ ${st.outcome.failed} failed / ${st.outcome.total} tests`);
    this.chargeUsage(run, st);
    this.emit('step.finished', { stepId: st.id, key: st.key, role: st.role, status: 'succeeded', summary: st.summary }, run.id, run.projectId);
    this.advance(run, st);
  }

  chargeUsage(run: MRun, st: MStep) {
    if (!st.inTok) return;
    const cost = (st.inTok * PRICE.input + st.outTok * PRICE.output) / 1e6;
    run.costUsd += cost;
    this.usage.push({ runId: run.id, cost, inTok: st.inTok, outTok: st.outTok, at: Date.now() });
  }

  advance(run: MRun, st: MStep) {
    switch (st.key) {
      case 'plan':
        this.transition(run, 'running');
        this.addStep(run, 'implement');
        return;
      case 'implement':
        this.transition(run, 'validating');
        this.addStep(run, 'test');
        return;
      case 'test':
        if (st.outcome.passed) this.addStep(run, 'review');
        else {
          this.transition(run, 'running', { fixLoops: run.fixLoops + 1 });
          this.addStep(run, 'implement');
        }
        return;
      case 'review':
        this.addStep(run, run.pr ? 'update_pr' : 'draft_pr');
        return;
      default:
        this.transition(run, 'pr_ready');
        this.transition(run, 'waiting_review', { autoReviewAt: Date.now() + 55_000 + Math.random() * 30_000 });
        this.createApproval(run, 'pr_review', 'reviewer', `Draft PR #${run.pr!.number} のレビュー`, this.prPayload(run));
    }
  }

  prPayload(run: MRun) {
    const impl = [...this.steps].reverse().find((s) => s.runId === run.id && s.key === 'implement');
    return { pr: run.pr, revision: run.revisionCount, testsPassed: true, diff: impl?.outcome.diff ?? null, note: 'GitHub 上で人間がレビューします。マージは人間の操作です。' };
  }

  createApproval(run: MRun, actionType: ApprovalActionType, role: AgentRole, title: string, payload: Record<string, unknown>, announce = true) {
    const id = nid('apr');
    const ap: MApproval = {
      id,
      runId: run.id,
      projectId: run.projectId,
      actionType,
      requestedByRole: role,
      title,
      payload,
      payloadDigest: `sha256:${sha256Hex(JSON.stringify({ id, actionType, payload }))}`,
      status: 'pending',
      version: 1,
      expiresAt: Date.now() + (actionType === 'pr_review' ? 14 : 3) * 24 * 3600_000,
      decidedBy: null,
      decidedAt: null,
      decisionComment: null,
      createdAt: Date.now(),
    };
    this.approvals.unshift(ap);
    if (announce) this.emit('approval.requested', { approvalId: id, actionType, title }, run.id, run.projectId);
  }

  resolveApprovals(run: MRun, status: ApprovalStatus, by: string, comment: string | null) {
    for (const a of this.approvals) {
      if (a.runId === run.id && a.status === 'pending') {
        a.status = status;
        a.version += 1;
        a.decidedBy = by;
        a.decidedAt = Date.now();
        a.decisionComment = comment;
        this.emit('approval.resolved', { approvalId: a.id, status, decidedBy: by }, run.id, run.projectId);
      }
    }
  }

  applyReview(run: MRun, state: 'approved' | 'changes_requested', body: string, reviewer: string) {
    if (run.status !== 'waiting_review') return 'ignored_not_waiting';
    this.resolveApprovals(run, state === 'approved' ? 'approved' : 'changes_requested', `github:${reviewer}`, body || null);
    if (state === 'approved') {
      this.transition(run, 'approved');
      this.transition(run, 'completed');
      return 'approved';
    }
    if (run.revisionCount >= run.maxRevisionAttempts) {
      this.transition(run, 'needs_input', { guidance: body });
      this.createApproval(run, 'clarification', 'planner', '再修正の上限に達しました', {
        reason: 'revision_limit',
        revisionCount: run.revisionCount,
        maxRevisionAttempts: run.maxRevisionAttempts,
        lastReviewComment: body,
        pr: run.pr,
        note: '続行を許可すると再計画から再開します。中止すると Run を終了します。',
      });
      return 'escalated';
    }
    this.transition(run, 'revising', { revisionCount: run.revisionCount + 1, guidance: body || 'レビュー指摘への対応', fixLoops: 0 });
    this.addStep(run, 'implement');
    return 'revision_started';
  }

  cancel(run: MRun, reason: string) {
    this.transition(run, 'cancelled', { errorCode: 'CANCELLED_BY_USER', errorMessage: reason });
    for (const s of this.steps) if (s.runId === run.id && (s.status === 'pending' || s.status === 'running')) {
      s.status = 'cancelled';
      s.finishedAt = Date.now();
    }
    for (const a of this.approvals) if (a.runId === run.id && a.status === 'pending') {
      a.status = 'superseded';
      a.version += 1;
    }
  }

  /* ---------------- tick ---------------- */
  tick() {
    const now = Date.now();
    // スケジューラ
    if (!this.settings.paused) {
      const active = this.runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).length;
      const queued = this.runs.filter((r) => r.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
      for (const r of queued.slice(0, Math.max(0, this.settings.maxConcurrentRuns - active))) {
        this.transition(r, 'planning');
        this.addStep(r, 'plan');
      }
    }
    // ステップ実行
    for (const st of this.steps) {
      if (st.status !== 'pending' && st.status !== 'running') continue;
      const run = this.runs.find((r) => r.id === st.runId)!;
      if (TERMINAL_RUN_STATUSES.includes(run.status)) continue;
      if (st.status === 'pending') {
        if (['planning', 'running', 'validating', 'revising'].includes(run.status)) this.startStep(run, st);
        continue;
      }
      const elapsed = now - st.startedAt!;
      while (st.emitted < st.script.length && st.script[st.emitted].at <= elapsed) {
        const s = st.script[st.emitted++];
        this.log(run, st, s.kind, s.message);
      }
      if (elapsed >= st.duration) this.finishStep(run, st);
    }
    // デモ用の GitHub イベント
    if (this.settings.demoTraffic && !this.settings.paused) {
      if (now >= this.nextTraffic) {
        this.nextTraffic = now + 16_000 + Math.random() * 14_000;
        this.trafficIssue();
      }
      for (const r of this.runs) {
        if (r.status === 'waiting_review' && r.autoReviewAt && now >= r.autoReviewAt) {
          r.autoReviewAt = undefined;
          const approve = r.revisionCount > 0 || Math.random() < 0.6;
          this.emit('webhook.received', { event: 'pull_request_review.submitted', reason: approve ? 'approved' : 'revision_started', repo: this.projects.find((p) => p.id === r.projectId)?.repo }, r.id, r.projectId);
          this.applyReview(r, approve ? 'approved' : 'changes_requested', approve ? 'LGTM' : 'エラーメッセージを日本語に統一してください。', 'reviewer');
        }
      }
    }
    this.refreshSeats();
  }

  trafficIssue() {
    const queued = this.runs.filter((r) => r.status === 'queued').length;
    if (queued >= 2) return;
    const candidates = this.projects.filter((p) => p.automation);
    const p = candidates[Math.floor(Math.random() * candidates.length)];
    const ISSUES = [
      ['注文履歴を CSV でエクスポート', '管理画面から注文履歴を CSV でダウンロードしたい。Excel で文字化けしないように。'],
      ['商品検索にカテゴリフィルターを追加', '検索結果をカテゴリで絞り込めるようにしたい。'],
      ['請求書一覧のページネーションを cursor 方式に変更', 'offset 方式だと件数が多いときに遅い。'],
      ['日付表示がタイムゾーン境界でずれるバグを修正', 'JST の 0 時台の注文が前日扱いになる。'],
      ['通知一覧に未読バッジを表示', 'ヘッダーのベルに未読件数を出したい。'],
      ['セッション切れ時のエラー表示を改善', '401 のとき真っ白な画面になる。ログイン画面へ誘導したい。'],
      ['設定画面のフォームバリデーションを強化', '必須項目が空のまま保存できてしまう。'],
    ];
    const [title, body] = ISSUES[Math.floor(Math.random() * ISSUES.length)];
    this.issue(p, title, body, Math.random() > 0.12 ? ['agents-office', 'enhancement'] : ['question']);
  }

  issue(p: MProject, title: string, body: string, labels: string[]) {
    const number = p.nextIssue++;
    const deliveryId = crypto.randomUUID();
    if (!p.automation) {
      this.emit('webhook.ignored', { deliveryId, event: 'issues.opened', reason: 'automation_disabled', repo: p.repo }, null, p.id);
      return { deliveryId, number, accepted: false };
    }
    if (!labels.includes(p.triggerLabel)) {
      this.emit('webhook.ignored', { deliveryId, event: 'issues.opened', reason: 'label_mismatch', repo: p.repo }, null, p.id);
      return { deliveryId, number, accepted: false };
    }
    const run = this.createRun(p, `#${number} ${title}`, `${title}\n\n${body}`, { type: 'github_issue', issueNumber: number });
    this.emit('webhook.received', { deliveryId, event: 'issues.opened', reason: 'run_created', repo: p.repo }, run.id, p.id);
    return { deliveryId, number, accepted: true };
  }

  projectionInput(): ProjectionInput {
    const since = Date.now() - 24 * 3600_000;
    const runs = this.runs.filter((r) => !TERMINAL_RUN_STATUSES.includes(r.status) || r.updatedAt >= since);
    const ids = new Set(runs.map((r) => r.id));
    return {
      now: new Date(),
      workspaceId: WS,
      projects: this.projects.map((p) => ({ id: p.id })),
      agents: AGENTS.map((a) => ({ id: a.id, role: a.role, name: a.name, version: 1 })),
      runs: runs.map((r) => ({ id: r.id, projectId: r.projectId, title: r.title, status: r.status, prNumber: r.pr?.number ?? null, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt), finishedAt: r.finishedAt ? new Date(r.finishedAt) : null })),
      steps: this.steps
        .filter((s) => ids.has(s.runId))
        .map((s) => ({ id: s.id, runId: s.runId, projectId: this.runs.find((r) => r.id === s.runId)!.projectId, role: s.role, key: s.key, status: s.status, startedAt: s.startedAt ? new Date(s.startedAt) : null, finishedAt: s.finishedAt ? new Date(s.finishedAt) : null })),
      approvals: this.approvals.filter((a) => a.status === 'pending').map((a) => ({ id: a.id, runId: a.runId, projectId: a.projectId, actionType: a.actionType, requestedByRole: a.requestedByRole, createdAt: new Date(a.createdAt) })),
    };
  }

  refreshSeats() {
    const seats = buildSeats(this.projectionInput());
    for (const s of seats) {
      const sig = `${s.status}|${s.currentRun?.id ?? ''}|${s.currentRun?.stepKey ?? ''}`;
      const prev = this.seatSig.get(s.key);
      this.seatSig.set(s.key, sig);
      if (prev !== undefined && prev !== sig) this.emit('agent.status_changed', { seat: s }, null, s.projectId);
    }
  }

  /* ---------------- view models ---------------- */
  summarize(r: MRun): RunSummary {
    const mine = this.steps.filter((s) => s.runId === r.id);
    const open = mine.filter((s) => s.status === 'running' || s.status === 'pending');
    const cur = open[open.length - 1] ?? mine[mine.length - 1] ?? null;
    return {
      id: r.id,
      projectId: r.projectId,
      title: r.title,
      status: r.status,
      statusVersion: r.statusVersion,
      sourceType: r.source.type,
      runtime: 'simulated',
      issueNumber: r.source.issueNumber ?? null,
      prNumber: r.pr?.number ?? null,
      currentStep: cur ? { key: cur.key, role: cur.role, status: cur.status } : null,
      progress: runProgress(r.status, cur?.key ?? null),
      revisionCount: r.revisionCount,
      costUsd: Math.round(r.costUsd * 1e4) / 1e4,
      errorCode: r.errorCode,
      createdAt: iso(r.createdAt)!,
      updatedAt: iso(r.updatedAt)!,
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
    };
  }

  monthCost() {
    return this.usage.reduce((a, u) => a + u.cost, 0);
  }

  officeState(): OfficeState {
    const input = this.projectionInput();
    const since = Date.now() - 24 * 3600_000;
    const visible = this.runs
      .filter((r) => !TERMINAL_RUN_STATUSES.includes(r.status) || r.updatedAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt);
    const monthCost = this.monthCost();
    return {
      workspace: { id: WS, name: 'あなたのワークスペース', settings: { ...this.settings } },
      projects: this.projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        color: p.color,
        position: p.position,
        status: 'active' as const,
        repo: { fullName: p.repo, claudeReady: false, automationEnabled: p.automation, triggerLabel: p.triggerLabel, maxRevisionAttempts: p.maxRevisionAttempts, events: ['issues.opened', 'issues.labeled'] },
        stats: buildProjectStats(input, p.id),
      })),
      seats: buildSeats(input) as SeatViewModel[],
      hub: {
        queued: visible.filter((r) => r.status === 'queued').length,
        active: visible.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).length,
        waitingApproval: this.approvals.filter((a) => a.status === 'pending').length,
        completed24h: visible.filter((r) => r.status === 'completed' && (r.finishedAt ?? 0) >= since).length,
        webhooks24h: this.events.filter((e) => e.type === 'webhook.received' || e.type === 'webhook.ignored').length,
        paused: this.settings.paused,
        budgetExceeded: monthCost >= this.settings.monthlyBudgetUsd,
      },
      runs: visible.slice(0, 120).map((r) => this.summarize(r)),
      approvalsPending: this.approvals.filter((a) => a.status === 'pending').length,
      budget: { monthCostUsd: Math.round(monthCost * 1e4) / 1e4, monthlyBudgetUsd: this.settings.monthlyBudgetUsd },
      sequence: this.seq,
      generatedAt: new Date().toISOString(),
    };
  }

  projectDto(p: MProject) {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      color: p.color,
      position: p.position,
      status: 'active',
      agentConfig: { roles: [...AGENT_ROLES], workflow: 'issue_to_draft_pr' },
      createdAt: iso(this.startedAt),
      updatedAt: iso(this.startedAt),
      repository: {
        id: `rbd_${p.id}`,
        fullName: p.repo,
        installationId: 4242,
        repositoryId: parseInt(sha256Hex(p.repo).slice(0, 7), 16),
        verification: 'simulated',
        automationEnabled: p.automation,
        policy: { triggerLabel: p.triggerLabel, events: ['issues.opened', 'issues.labeled'], maxRevisionAttempts: p.maxRevisionAttempts, enabled: p.automation },
      },
    };
  }

  approvalDto(a: MApproval) {
    const r = this.runs.find((x) => x.id === a.runId)!;
    const p = this.projects.find((x) => x.id === a.projectId)!;
    return {
      ...a,
      workspaceId: WS,
      expiresAt: iso(a.expiresAt),
      decidedAt: iso(a.decidedAt),
      createdAt: iso(a.createdAt),
      run: { id: r.id, title: r.title, status: r.status },
      project: { id: p.id, name: p.name, color: p.color },
    };
  }

  wsJson() {
    return { id: WS, name: 'あなたのワークスペース', settings: { ...this.settings }, createdAt: iso(this.startedAt) };
  }

  /* ---------------- HTTP ---------------- */
  handle(method: string, url: URL, body: any): [number, unknown] {
    const path = url.pathname;
    const q = url.searchParams;
    const err = (status: number, code: string, message: string): [number, unknown] => [status, { code, message, requestId: 'demo' }];
    const runOf = (id: string) => this.runs.find((r) => r.id === id);
    let m: RegExpMatchArray | null;

    if (method === 'GET' && path === '/v1/auth/config') return [200, { mode: 'demo', devRoutes: true, devAccounts: [] }];
    if (method === 'POST' && path === '/v1/auth/logout') return [200, { ok: true }];
    if (method === 'GET' && path === '/v1/me') return [200, { user: USER, workspace: this.wsJson() }];
    if (method === 'GET' && path === '/v1/runtime') {
      return [
        200,
        {
          runtime: 'simulated',
          mode: 'simulated',
          reason: 'ブラウザ内デモのためシミュレーションです',
          model: null,
          effort: null,
          fallbacks: null,
          billing: 'none',
          claudeCode: { bin: 'claude', restricted: true, allowApiBilling: false, maxTurns: { plan: 30, review: 30, develop: 60 }, version: null, loggedIn: null, authMethod: null, authLabel: null, problem: null },
          stepTimeoutMs: 120000,
          note: 'ローカル版では、この PC の Claude Code にサブスク（claude.ai アカウント）でログインしているか ANTHROPIC_API_KEY を設定し、Project にローカルリポジトリを指定すると Claude が作業します。',
        },
      ];
    }
    if (method === 'GET' && path === '/v1/workspaces/me') return [200, this.wsJson()];
    if (method === 'GET' && path === '/v1/workspaces/me/office-state') return [200, this.officeState()];
    if (method === 'GET' && path === '/v1/events') {
      const after = Number(q.get('after') ?? 0);
      return [200, { events: this.events.filter((e) => (e.sequence ?? 0) > after), sequence: this.seq, resync: false }];
    }
    if (method === 'PATCH' && path === '/v1/workspaces/me/settings') {
      Object.assign(this.settings, body ?? {});
      this.emit('workspace.updated', { settings: { ...this.settings } });
      return [200, this.wsJson()];
    }
    if (method === 'POST' && path === '/v1/workspaces/me/kill-switch') {
      this.settings.paused = body?.action === 'pause';
      let cancelled = 0;
      if (this.settings.paused && body?.cancelActive) {
        for (const r of this.runs) if (r.status === 'queued' || (ACTIVE_RUN_STATUSES.includes(r.status) && r.status !== 'approved')) {
          this.cancel(r, 'キルスイッチによる一括停止');
          cancelled++;
        }
      }
      this.audit.unshift({ id: nid('aud'), action: this.settings.paused ? 'kill_switch.paused' : 'kill_switch.resumed', targetType: 'workspace', targetId: WS, detail: {}, createdAt: new Date().toISOString() });
      this.emit('workspace.updated', { settings: { ...this.settings }, cancelled });
      return [200, { ...this.wsJson(), cancelled }];
    }
    if (method === 'GET' && path === '/v1/agents') {
      const seats = buildSeats(this.projectionInput());
      return [200, { agents: AGENTS.map((a) => {
        const mine = seats.filter((s) => s.agentId === a.id);
        const order = ['working', 'reviewing', 'waiting_approval', 'failed', 'completed', 'idle'];
        const status = mine.map((s) => s.status).sort((x, y) => order.indexOf(x) - order.indexOf(y))[0] ?? 'idle';
        return { id: a.id, role: a.role, name: a.name, model: 'simulated-local', runtime: a.runtime, promptVersion: `${a.role}@1.0.0`, toolPolicy: a.tools, version: 1, status, activeRunIds: mine.flatMap((s) => s.activeRunIds), activeProjectIds: mine.flatMap((s) => s.activeProjectIds) };
      }) }];
    }
    if (method === 'GET' && path === '/v1/usage') {
      const byDay = new Map<string, { cost: number; runs: Set<string> }>();
      for (const u of this.usage) {
        const d = new Date(u.at).toISOString().slice(0, 10);
        const cur = byDay.get(d) ?? { cost: 0, runs: new Set() };
        cur.cost += u.cost;
        cur.runs.add(u.runId);
        byDay.set(d, cur);
      }
      return [200, {
        measurement: 'estimated',
        note: 'ブラウザ内デモのシミュレーション単価による推定値です',
        pricePerMTok: PRICE,
        month: { costUsd: this.monthCost(), inputTokens: this.usage.reduce((a, u) => a + u.inTok, 0), outputTokens: this.usage.reduce((a, u) => a + u.outTok, 0), budgetUsd: this.settings.monthlyBudgetUsd },
        limits: { runBudgetUsd: this.settings.runBudgetUsd, maxConcurrentRuns: this.settings.maxConcurrentRuns, activeRuns: this.runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).length, paused: this.settings.paused },
        daily: [...byDay.entries()].sort().map(([day, v]) => ({ day, costUsd: v.cost, runs: v.runs.size })),
        byProject: this.projects.map((p) => ({ projectId: p.id, name: p.name, costUsd: this.runs.filter((r) => r.projectId === p.id).reduce((a, r) => a + r.costUsd, 0), runs: this.runs.filter((r) => r.projectId === p.id).length })),
      }];
    }
    if (method === 'GET' && path === '/v1/audit-logs') return [200, { items: this.audit.slice(0, 100) }];
    if (method === 'GET' && path === '/v1/projects') return [200, { items: this.projects.map((p) => this.projectDto(p)) }];
    if (method === 'GET' && path === '/v1/integrations/github/installations') return [200, { mode: 'simulated', installations: [] }];
    if ((m = path.match(/^\/v1\/projects\/([^/]+)\/automation-policy$/)) && method === 'PUT') {
      const p = this.projects.find((x) => x.id === m![1]);
      if (!p) return err(404, 'NOT_FOUND', 'Project が見つかりません');
      p.automation = Boolean(body?.enabled);
      p.triggerLabel = String(body?.triggerLabel ?? p.triggerLabel);
      p.maxRevisionAttempts = Number(body?.maxRevisionAttempts ?? p.maxRevisionAttempts);
      this.emit('project.updated', { action: 'automation_updated', enabled: p.automation }, null, p.id);
      return [200, this.projectDto(p)];
    }
    if (path.startsWith('/v1/projects')) return err(400, 'DEMO_READONLY', 'ブラウザ内デモでは Project の作成・変更はできません（ローカル版では可能です）');

    if (method === 'POST' && path === '/v1/runs') {
      const p = this.projects.find((x) => x.id === body?.projectId);
      if (!p) return err(404, 'NOT_FOUND', 'Project が見つかりません');
      if (this.settings.paused) return err(409, 'WORKSPACE_PAUSED', 'キルスイッチで停止中です。設定から再開してください');
      const request = String(body?.request ?? '').trim();
      if (request.length < 4) return err(400, 'VALIDATION_ERROR', '依頼内容が短すぎます');
      const run = this.createRun(p, request.split('\n')[0].slice(0, 80), request, { type: 'manual' });
      this.audit.unshift({ id: nid('aud'), action: 'run.created', targetType: 'run', targetId: run.id, detail: {}, createdAt: new Date().toISOString() });
      return [202, { runId: run.id, status: run.status, projectId: p.id }];
    }
    if (method === 'GET' && path === '/v1/runs') {
      const statuses = (q.get('status') ?? '').split(',').filter(Boolean);
      const pid = q.get('projectId');
      const text = (q.get('q') ?? '').toLowerCase();
      const items = this.runs
        .filter((r) => (!statuses.length || statuses.includes(r.status)) && (!pid || r.projectId === pid) && (!text || r.title.toLowerCase().includes(text) || r.id.includes(text)))
        .sort((a, b) => b.createdAt - a.createdAt);
      const limit = Number(q.get('limit') ?? 30);
      return [200, { items: items.slice(0, limit).map((r) => {
        const p = this.projects.find((x) => x.id === r.projectId)!;
        return { ...this.summarize(r), project: { id: p.id, name: p.name, color: p.color } };
      }), nextCursor: null, total: items.length }];
    }
    if ((m = path.match(/^\/v1\/runs\/([^/]+)$/)) && method === 'GET') {
      const r = runOf(m[1]);
      if (!r) return err(404, 'NOT_FOUND', 'Run が見つかりません');
      const p = this.projects.find((x) => x.id === r.projectId)!;
      const steps = this.steps.filter((s) => s.runId === r.id).sort((a, b) => a.seq - b.seq);
      const usage = this.usage.filter((u) => u.runId === r.id);
      return [200, {
        run: {
          ...this.summarize(r),
          request: r.request,
          source: r.source,
          plan: r.plan,
          guidance: r.guidance,
          maxRevisionAttempts: r.maxRevisionAttempts,
          fixLoops: r.fixLoops,
          budgetLimitUsd: this.settings.runBudgetUsd,
          pr: r.pr,
          branch: this.ctx(r).branch,
          errorMessage: r.errorMessage,
          durationMs: r.startedAt ? (r.finishedAt ?? Date.now()) - r.startedAt : null,
        },
        project: { id: p.id, name: p.name, color: p.color },
        repository: { fullName: p.repo },
        steps: steps.map((s) => ({
          id: s.id,
          seq: s.seq,
          key: s.key,
          role: s.role,
          agentId: AGENTS.find((a) => a.role === s.role)?.id ?? null,
          agentVersion: s.role === 'tool_broker' ? null : 1,
          model: s.role === 'tool_broker' ? 'policy-broker' : 'simulated-local',
          status: s.status,
          attempt: s.attempt,
          maxAttempts: s.role === 'tool_broker' ? 3 : 2,
          revision: s.revision,
          summary: s.summary,
          errorCode: s.errorCode,
          startedAt: iso(s.startedAt),
          finishedAt: iso(s.finishedAt),
        })),
        approvals: this.approvals.filter((a) => a.runId === r.id).map((a) => ({ ...a, workspaceId: WS, expiresAt: iso(a.expiresAt), decidedAt: iso(a.decidedAt), createdAt: iso(a.createdAt) })),
        artifacts: this.artifacts.filter((a) => a.runId === r.id).map((a) => ({ id: a.id, kind: a.kind, title: a.title, stepId: a.stepId, mediaType: a.mediaType, sizeBytes: new Blob([a.content]).size, checksum: `sha256:${sha256Hex(a.content)}`, createdAt: iso(a.createdAt) })),
        usage: { measurement: 'estimated', inputTokens: usage.reduce((x, u) => x + u.inTok, 0), outputTokens: usage.reduce((x, u) => x + u.outTok, 0), estimatedCostUsd: usage.reduce((x, u) => x + u.cost, 0), records: usage.length },
        events: this.events.filter((e) => e.runId === r.id).map((e) => ({ id: e.eventId, sequence: e.sequence, type: e.type, occurredAt: e.occurredAt, data: e.data })),
      }];
    }
    if ((m = path.match(/^\/v1\/runs\/([^/]+)\/logs$/)) && method === 'GET') {
      const stepId = q.get('stepId');
      const after = Number(q.get('after') ?? 0);
      return [200, { items: this.logs.filter((l) => l.runId === m![1] && (!stepId || l.stepId === stepId) && l.id > after) }];
    }
    if ((m = path.match(/^\/v1\/runs\/([^/]+)\/cancel$/)) && method === 'POST') {
      const r = runOf(m[1]);
      if (!r) return err(404, 'NOT_FOUND', 'Run が見つかりません');
      if (TERMINAL_RUN_STATUSES.includes(r.status)) return err(409, 'RUN_ALREADY_FINISHED', 'この Run は既に終了しています');
      this.cancel(r, 'あなたが中止');
      return [200, { runId: r.id, status: r.status, statusVersion: r.statusVersion }];
    }
    if ((m = path.match(/^\/v1\/artifacts\/([^/]+)$/)) && method === 'GET') {
      const a = this.artifacts.find((x) => x.id === m![1]);
      if (!a) return err(404, 'NOT_FOUND', '成果物が見つかりません');
      return [200, { id: a.id, runId: a.runId, kind: a.kind, title: a.title, mediaType: a.mediaType, checksum: `sha256:${sha256Hex(a.content)}`, createdAt: iso(a.createdAt), content: a.content }];
    }
    if (method === 'GET' && path === '/v1/approvals') {
      const all = q.get('status') === 'all';
      return [200, { items: this.approvals.filter((a) => all || a.status === 'pending').map((a) => this.approvalDto(a)) }];
    }
    if ((m = path.match(/^\/v1\/approvals\/([^/]+)\/decision$/)) && method === 'POST') {
      const a = this.approvals.find((x) => x.id === m![1]);
      if (!a) return err(404, 'NOT_FOUND', '承認が見つかりません');
      if (a.status !== 'pending') return err(409, 'ALREADY_DECIDED', 'この承認は既に処理済みです');
      if (a.version !== body?.expectedVersion) return err(409, 'VERSION_CONFLICT', '承認内容が更新されています。再読み込みしてください');
      if (a.payloadDigest !== body?.confirmationDigest) return err(409, 'DIGEST_MISMATCH', '承認対象の内容が変わっています');
      if (a.actionType === 'pr_review') return err(409, 'DECIDE_ON_GITHUB', 'Draft PR のレビューは GitHub 上で行います');
      if (a.actionType === 'dangerous_operation' && body?.decision === 'approve') return err(403, 'POLICY_FORBIDDEN', 'MVP では危険な操作は承認しても実行できません');
      if (body?.decision === 'request_changes' && !body?.comment) return err(400, 'COMMENT_REQUIRED', '差し戻しには指示コメントが必要です');
      const r = runOf(a.runId)!;
      const status: ApprovalStatus = body.decision === 'approve' ? 'approved' : body.decision === 'request_changes' ? 'changes_requested' : 'rejected';
      a.status = status;
      a.version += 1;
      a.decidedBy = USER.id;
      a.decidedAt = Date.now();
      a.decisionComment = body.comment ?? null;
      this.emit('approval.resolved', { approvalId: a.id, status, decidedBy: USER.id }, r.id, r.projectId);
      this.audit.unshift({ id: nid('aud'), action: `approval.${status}`, targetType: 'approval', targetId: a.id, detail: {}, createdAt: new Date().toISOString() });
      if (status === 'rejected') this.cancel(r, '承認者が却下');
      else if (r.status === 'needs_input') {
        const guidance = a.actionType === 'dangerous_operation' ? `危険な操作は除外し、安全な範囲のみ実施。${body.comment ?? ''}` : body.comment ?? '現状の方針で続行';
        this.transition(r, 'planning', { guidance, fixLoops: 0, ...(a.actionType === 'clarification' ? { revisionCount: 0 } : {}) });
        this.addStep(r, 'plan');
      }
      return [200, { approvalId: a.id, status, version: a.version, runId: r.id, runStatus: r.status }];
    }
    if (method === 'POST' && path === '/v1/dev/github/simulate') {
      if (body?.kind === 'review') {
        const r = runOf(body.runId);
        if (!r || r.status !== 'waiting_review') return err(409, 'NOT_WAITING_REVIEW', 'この Run はレビュー待ちではありません');
        const deliveryId = crypto.randomUUID();
        this.emit('webhook.received', { deliveryId, event: 'pull_request_review.submitted', reason: body.state, repo: this.projects.find((p) => p.id === r.projectId)?.repo }, r.id, r.projectId);
        this.applyReview(r, body.state, String(body.body ?? ''), USER.username);
        return [200, { status: 202, body: { status: 'accepted', deliveryId }, deliveryId }];
      }
      if (body?.kind === 'issue') {
        const p = this.projects.find((x) => x.id === body.projectId);
        if (!p) return err(404, 'NOT_FOUND', 'Project が見つかりません');
        const res = this.issue(p, String(body.title ?? ''), String(body.body ?? ''), body.labels ?? []);
        return [200, { status: 202, body: { status: 'accepted', deliveryId: res.deliveryId }, deliveryId: res.deliveryId, issueNumber: res.number }];
      }
      if (body?.kind === 'redeliver') return [200, { status: 200, body: { status: 'duplicate', deliveryId: body.deliveryId }, deliveryId: body.deliveryId }];
    }
    return err(404, 'NOT_FOUND', `デモでは未対応の API です: ${method} ${path}`);
  }
}

/* ------------------------------------------------------------------ */
/* install                                                             */
/* ------------------------------------------------------------------ */

class DemoEventSource extends EventTarget {
  static server: DemoServer;
  readonly url: string;
  readonly withCredentials = true;
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  private unsub: (() => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    const after = Number(new URL(url, window.location.href).searchParams.get('after') ?? 0);
    window.setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      const s = DemoEventSource.server;
      for (const e of s.events) if ((e.sequence ?? 0) > after) this.send(e);
      const fn = (e: WorkspaceEvent) => this.send(e);
      s.listeners.add(fn);
      this.unsub = () => s.listeners.delete(fn);
      this.dispatchEvent(new MessageEvent('ready', { data: JSON.stringify({ workspaceId: WS }) }));
    }, 60);
  }

  private send(e: WorkspaceEvent) {
    this.dispatchEvent(new MessageEvent(e.sequence === null ? 'transient' : 'event', { data: JSON.stringify(e), lastEventId: e.sequence === null ? '' : String(e.sequence) }));
  }

  close() {
    this.readyState = 2;
    this.unsub?.();
  }
}

export function installMockBackend() {
  const server = new DemoServer();
  DemoEventSource.server = server;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (!url.pathname.startsWith('/v1/')) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    await new Promise((r) => setTimeout(r, 25));
    const [status, data] = server.handle(method, url, body);
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  };
  (window as unknown as { EventSource: unknown }).EventSource = DemoEventSource;
  return server;
}
