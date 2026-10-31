/**
 * シミュレーション Runner が生成する成果物の内容（純粋関数）。
 * 実際の OpenAI Agents SDK / Codex SDK は未接続のため、依頼文から決定的にサンプルを生成する。
 * 生成物の先頭には必ずシミュレーションである旨を明記する。
 */
import { sha256Hex } from '../lib/crypto';

export const SIM_NOTICE =
  '> ⚠ ローカル版シミュレーション: この成果物はシミュレーション Runner が生成したサンプルです（実際のコード変更・GitHub 操作は行っていません）。';

export interface ContentContext {
  runId: string;
  title: string;
  request: string;
  repo: string | null;
  revision: number;
  guidance: string | null;
  branch: string;
}

interface Topic {
  area: string;
  files: string[];
  criteria: string[];
}

const TOPICS: { re: RegExp; topic: Topic }[] = [
  {
    re: /ログイン|login|サインイン|パスワード|password|認証|auth/i,
    topic: {
      area: 'auth',
      files: ['src/features/auth/LoginForm.tsx', 'src/features/auth/usePasswordVisibility.ts', 'tests/auth/login.test.tsx'],
      criteria: ['パスワード表示切替がキーボードで操作できる', '既存のログインテストが通る', 'aria-label が状態に応じて変わる'],
    },
  },
  {
    re: /csv|エクスポート|export|ダウンロード|download/i,
    topic: {
      area: 'export',
      files: ['src/features/export/toCsv.ts', 'src/features/export/ExportButton.tsx', 'tests/export/toCsv.test.ts'],
      criteria: ['カンマ・改行を含む値が正しくエスケープされる', 'UTF-8 BOM 付きで Excel で文字化けしない', '1万行でもUIが固まらない'],
    },
  },
  {
    re: /ダーク|dark|テーマ|theme|配色/i,
    topic: {
      area: 'theme',
      files: ['src/theme/tokens.ts', 'src/theme/ThemeToggle.tsx', 'tests/theme/theme.test.tsx'],
      criteria: ['OS 設定に追従する', '切替状態が再訪時に復元される', 'コントラスト比 4.5:1 以上'],
    },
  },
  {
    re: /レート|rate|api|エンドポイント|endpoint|webhook/i,
    topic: {
      area: 'api',
      files: ['src/server/routes/items.ts', 'src/server/middleware/rateLimit.ts', 'tests/server/items.test.ts'],
      criteria: ['上限超過時に 429 と Retry-After を返す', '認証済みユーザー単位で計測する', '既存 API のレスポンス形式を変えない'],
    },
  },
  {
    re: /検索|search|フィルター|filter|絞り込み/i,
    topic: {
      area: 'search',
      files: ['src/features/search/useSearch.ts', 'src/features/search/SearchBox.tsx', 'tests/search/useSearch.test.ts'],
      criteria: ['入力から 300ms デバウンスする', '空文字では全件表示', 'IME 変換中は検索しない'],
    },
  },
  {
    re: /通知|notification|メール|email|slack/i,
    topic: {
      area: 'notifications',
      files: ['src/features/notifications/NotificationList.tsx', 'src/features/notifications/api.ts', 'tests/notifications/list.test.tsx'],
      criteria: ['未読件数がバッジに表示される', '既読化が楽観的更新される', '外部送信は行わない（下書きのみ）'],
    },
  },
  {
    re: /ページ|pagination|一覧|list|テーブル|table/i,
    topic: {
      area: 'listing',
      files: ['src/features/list/usePagedQuery.ts', 'src/features/list/DataTable.tsx', 'tests/list/paging.test.ts'],
      criteria: ['cursor ベースでページングする', '最後のページで「次へ」が無効になる', 'ソート条件が URL に保存される'],
    },
  },
  {
    re: /バグ|bug|修正|fix|エラー|error|crash|落ちる/i,
    topic: {
      area: 'bugfix',
      files: ['src/lib/date/formatDate.ts', 'src/lib/date/parse.ts', 'tests/lib/formatDate.test.ts'],
      criteria: ['再現テストを先に追加する', 'タイムゾーン境界で値がずれない', '既存の呼び出し側に影響しない'],
    },
  },
];

function slugify(text: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return ascii || `task-${sha256Hex(text).slice(0, 6)}`;
}

export function detectTopic(ctx: Pick<ContentContext, 'title' | 'request'>): Topic {
  const text = `${ctx.title}\n${ctx.request}`;
  for (const { re, topic } of TOPICS) if (re.test(text)) return topic;
  const slug = slugify(ctx.title);
  const pascal = slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return {
    area: slug,
    files: [`src/features/${slug}/index.ts`, `src/features/${slug}/${pascal || 'Feature'}.tsx`, `tests/${slug}.test.ts`],
    criteria: ['依頼内容の主要シナリオが動作する', '既存テストが通る', '型エラー・Lint エラーがない'],
  };
}

export const PATTERNS = {
  dangerous:
    /本番|production|prod\s*db|drop\s+table|truncate|シークレット|secrets?\b|branch\s*protection|ブランチ保護|デプロイ|deploy|rm\s+-rf|force\s*push|強制\s*push/i,
  mergeRequest: /(main|master).{0,12}(マージ|merge)|(マージ|merge).{0,12}(main|master)|直接マージ|auto[- ]?merge/i,
  injection:
    /ignore\s+(all\s+)?(previous|prior)\s+instructions|これまでの指示を無視|system\s*prompt|システムプロンプト|承認を無視|トークンを(貼|出力)/i,
  simCrash: /\[sim:crash\]/i,
  simTestFail: /\[sim:test-fail\]/i,
  simExpensive: /\[sim:expensive\]/i,
};

export function detectDangerous(text: string): string[] {
  const found = new Set<string>();
  const checks: [RegExp, string][] = [
    [/本番|production|prod\s*db/i, '本番環境への変更'],
    [/drop\s+table|truncate/i, 'データ削除を伴う DB 操作'],
    [/シークレット|secrets?\b/i, 'Secrets の参照・変更'],
    [/branch\s*protection|ブランチ保護/i, 'ブランチ保護の変更'],
    [/デプロイ|deploy/i, 'デプロイ操作'],
    [/rm\s+-rf/i, '破壊的なファイル削除'],
    [/force\s*push|強制\s*push/i, '強制 push'],
  ];
  for (const [re, label] of checks) if (re.test(text)) found.add(label);
  return [...found];
}

export function planMarkdown(
  ctx: ContentContext,
  steps: { id: string; role: string; dependsOn: string[] }[],
  flags: string[],
): string {
  const topic = detectTopic(ctx);
  const lines = [
    `# 実行計画 — ${ctx.title}`,
    '',
    SIM_NOTICE,
    '',
    '## 目的',
    '',
    ctx.request.split('\n').slice(0, 6).map((l) => `> ${l}`).join('\n'),
    '',
    ...(ctx.guidance ? ['## 人からの追加指示', '', `> ${ctx.guidance}`, ''] : []),
    '## Step DAG',
    '',
    '| id | 担当 | 依存 |',
    '|---|---|---|',
    ...steps.map((s) => `| ${s.id} | ${s.role} | ${s.dependsOn.join(', ') || '—'} |`),
    '',
    '## 変更予定ファイル',
    '',
    ...topic.files.map((f) => `- \`${f}\``),
    '',
    '## 受入条件',
    '',
    ...topic.criteria.map((c) => `- [ ] ${c}`),
    '',
    '## 必要権限',
    '',
    `- リポジトリ読み取り（${ctx.repo ?? '未接続'}）`,
    `- 隔離 worktree への書き込み（ブランチ \`${ctx.branch}\`）`,
    '- Draft PR 作成（Tool Broker 経由・ai/ ブランチのみ）',
    '- main へのマージ: **不可**（人間の操作）',
    '',
  ];
  if (flags.length) {
    lines.push('## 注意', '', ...flags.map((f) => `- ${f}`), '');
  }
  return lines.join('\n');
}

export interface DiffResult {
  patch: string;
  files: { path: string; additions: number; deletions: number }[];
  additions: number;
  deletions: number;
}

function codeFor(path: string, area: string, revision: number): { add: string[]; del: string[] } {
  const isTest = path.startsWith('tests/');
  const name = path.split('/').pop()!.replace(/\.(tsx?|jsx?)$/, '');
  if (isTest) {
    return {
      del: [],
      add: [
        `import { describe, expect, it } from 'vitest';`,
        `import { ${name.replace(/\.test$/, '')} } from '../../src/features/${area}';`,
        ``,
        `describe('${name.replace(/\.test$/, '')}', () => {`,
        `  it('handles the main scenario', () => {`,
        `    expect(${name.replace(/\.test$/, '')}({ input: 'ok' })).toMatchObject({ ok: true });`,
        `  });`,
        ...(revision > 0
          ? [`  it('covers the case raised in review #${revision}', () => {`, `    expect(${name.replace(/\.test$/, '')}({ input: '' })).toMatchObject({ ok: false });`, `  });`]
          : []),
        `});`,
      ],
    };
  }
  if (path.endsWith('.tsx')) {
    return {
      del: [`export function ${name}() {`, `  return <div className="${area}" />;`],
      add: [
        `export function ${name}({ disabled = false }: { disabled?: boolean }) {`,
        `  const [open, setOpen] = useState(false);`,
        `  return (`,
        `    <button`,
        `      type="button"`,
        `      aria-pressed={open}`,
        `      aria-label={open ? '閉じる' : '開く'}`,
        `      disabled={disabled}`,
        `      onClick={() => setOpen((v) => !v)}`,
        `    >`,
        `      {open ? '閉じる' : '開く'}`,
        `    </button>`,
        `  );`,
        ...(revision > 0 ? [`  // review #${revision}: focus outline を維持`] : []),
      ],
    };
  }
  return {
    del: [`export const ${name} = () => null;`],
    add: [
      `export interface ${name.charAt(0).toUpperCase() + name.slice(1)}Options {`,
      `  input: string;`,
      `  limit?: number;`,
      `}`,
      ``,
      `export function ${name}({ input, limit = 100 }: ${name.charAt(0).toUpperCase() + name.slice(1)}Options) {`,
      `  if (!input.trim()) return { ok: false as const, reason: 'empty' };`,
      `  const value = input.slice(0, limit);`,
      `  return { ok: true as const, value };`,
      `}`,
      ...(revision > 0 ? [``, `// review #${revision}: 境界値の扱いを明確化`] : []),
    ],
  };
}

export function generateDiff(ctx: ContentContext): DiffResult {
  const topic = detectTopic(ctx);
  const chunks: string[] = [];
  const files: DiffResult['files'] = [];
  for (const path of topic.files) {
    const { add, del } = codeFor(path, topic.area, ctx.revision);
    const isNew = del.length === 0;
    chunks.push(
      `diff --git a/${path} b/${path}`,
      ...(isNew ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
      `+++ b/${path}`,
      `@@ -${isNew ? 0 : 1},${del.length} +1,${add.length} @@`,
      ...del.map((l) => `-${l}`),
      ...add.map((l) => `+${l}`),
      '',
    );
    files.push({ path, additions: add.length, deletions: del.length });
  }
  const header = [
    `# ${SIM_NOTICE.replace(/^> /, '')}`,
    `# branch: ${ctx.branch}  revision: ${ctx.revision}`,
    '',
  ];
  return {
    patch: [...header, ...chunks].join('\n'),
    files,
    additions: files.reduce((a, f) => a + f.additions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
  };
}

export function testReport(ctx: ContentContext, passed: boolean, seed: number) {
  const total = 96 + (seed % 60);
  const failures = passed
    ? []
    : [
        {
          test: `${detectTopic(ctx).files[2]} > handles the main scenario`,
          message: 'Expected { ok: true } but received { ok: false, reason: "empty" }',
        },
      ];
  return {
    simulated: true,
    commands: ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm build', 'pnpm test'],
    passed,
    total,
    failed: failures.length,
    durationMs: 18_000 + (seed % 9000),
    failures,
  };
}

export function reviewMarkdown(ctx: ContentContext, diff: DiffResult | null, blockers: string[]): string {
  const topic = detectTopic(ctx);
  return [
    `# レビュー結果 — ${ctx.title}`,
    '',
    SIM_NOTICE,
    '',
    `- 対象ブランチ: \`${ctx.branch}\`（revision ${ctx.revision}）`,
    `- 差分: ${diff ? `${diff.files.length} files, +${diff.additions} −${diff.deletions}` : '不明'}`,
    '',
    '## 受入条件との照合',
    '',
    ...topic.criteria.map((c) => `- ${blockers.length ? '△' : '✓'} ${c}`),
    '',
    '## 指摘',
    '',
    ...(blockers.length
      ? blockers.map((b) => `- **blocker**: ${b}`)
      : ['- nit: 変数名をより具体的に（任意）', '- nit: テストケース名を日本語の仕様に合わせる（任意）']),
    '',
    '## 判定',
    '',
    blockers.length
      ? '修正が必要です。Developer に差し戻します。'
      : 'Draft PR として提出可能です。**これは AI による自己レビューであり、PR の承認ではありません。** マージ可否は人間がレビューで判断します。',
    '',
  ].join('\n');
}

export function draftPrMarkdown(
  ctx: ContentContext,
  pr: { number: number; url: string; branch: string; headSha: string },
  testsPassed: boolean,
  update: boolean,
): string {
  return [
    `# ${update ? 'Draft PR 更新' : 'Draft PR 作成'} — #${pr.number}`,
    '',
    SIM_NOTICE,
    '',
    `- Repo: \`${ctx.repo}\``,
    `- ブランチ: \`${pr.branch}\` → \`main\`（Draft）`,
    `- head: \`${pr.headSha.slice(0, 12)}\``,
    `- URL（ローカル GitHub シミュレーター）: ${pr.url}`,
    `- テスト: ${testsPassed ? '✓ 通過' : '✗ 失敗'}`,
    '',
    '## 本文',
    '',
    `${ctx.title}`,
    '',
    ctx.request.split('\n').slice(0, 4).map((l) => `> ${l}`).join('\n'),
    '',
    '---',
    'マージは人間が GitHub 上で行います。AI はマージ操作を実行できません。',
    '',
  ].join('\n');
}

/** 簡易・決定的な疑似乱数（Run ID 等から生成） */
export function seededRandom(seedText: string): () => number {
  let h = parseInt(sha256Hex(seedText).slice(0, 8), 16) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
