# 自分用 AI 作業場（Issue の実行役）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agents-office を、t.arai が選んだ Issue と画面からの指示を Claude で実行し、GitHub に書く前に必ず承認を取る、EC2 常駐の自分用 AI 作業場にする。

**Architecture:** 既存の Run 工程（plan → implement → test → review → draft_pr）と Dispatcher の永続キューを活かす。Webhook の代わりに `GithubPoller` が GitHub を見に行き、合成した配信を同じキューに積む。GitHub への書き込みは新しい承認種別 `publish` の後にだけ行い、Tester は Docker コンテナで動かす。

**Tech Stack:** TypeScript（ESM ではなく既存どおりの拡張子なし import）、Hono、Drizzle + PGlite、vitest、React 19、Claude Code CLI 2.1.286、Docker、Tailscale。

**Spec:** `docs/superpowers/specs/2026-11-02-issue-runner-design.md`

## Global Constraints

- 起動ラベルは `agents-office`。`nightly-ok` と `needs-human` の Issue は自動では扱わない
- 資料コメントの 1 行目は `<!-- nightly-materials -->`。見出しは `## 決めること`・`## 現状`・`## 選択肢`・`## 会議で確かめる問い` の順。推奨・結論は書かない
- PR は通常の PR（`draft: false`）。本文 1 行目は `Closes #<番号>`（Issue のある Run だけ）
- push・PR 作成・Issue コメント・終わりのラベル操作は、`publish` 承認の後にだけ行う。失敗・中止での `agents-office` の取り外しと自分のアサインの取り外しだけは承認なしで行う
- 失敗・中止の理由は Issue に書かない
- サーバーモード（`PAW_PUBLIC_URL` あり）は、`PAW_SIGNUP=open`・`PAW_SEED_DEMO` 有効・`PAW_DEV_ROUTES` 有効・`PAW_CLAUDE_CODE_RESTRICTED=0`・`--restricted` 非対応 CLI のどれかで起動を拒む
- Tester はサーバーモードでは Docker 必須。使えなければ Run を失敗にする
- ポーリング間隔の既定は 60 秒（`PAW_GITHUB_POLL_MS`）
- コメントは日本語で、既存ファイルのトーンに合わせる
- `git add` はファイル単位で行う（`-A` や `.` を使わない）
- 完了の条件は `pnpm typecheck` と `pnpm test` が緑

## Review Focus

- 同じ Issue をポーリングが二度拾う（ラベルが残ったまま Run が終わった、再起動直後）→ 進行中か直近 Run がある間は Run を作らない。Task 11 にテストを置く
- `publish` 承認の後に worktree の HEAD が変わっている（人のコミット取り込みや再試行）→ 承認した head と違えば push せず承認を取り直す。Task 9 にテストを置く
- GitHub API の 1 ページ目しか見ない（100 件を超える Issue・コメント・イベント）→ 空になるまでページを進める。Task 10 にテストを置く
- 他人が担当に入っている Issue に手動ラベルが付いた → 見送り、画面に理由を出す。Task 11 にテストを置く
- サーバーの再起動で、`publish` 承認待ちや資料の投稿途中の Run が二重に書き込む → 投稿の前に既存の資料コメント・PR を探す。Task 6 と Task 12 にテストを置く

---

### Task 1: 型エラーと Mac で落ちるテストを直す

**Files:**
- Modify: `apps/api/src/server-mode.test.ts:53,66,67`
- Modify: `apps/api/src/claude-code.test.ts:173`

**Interfaces:**
- Produces: なし（以降のタスクの土台。`pnpm typecheck` と `pnpm test` が緑）

- [ ] **Step 1: 現状の失敗を確かめる**

Run: `pnpm typecheck` と `pnpm --filter @paw/api exec vitest run src/claude-code.test.ts`
Expected: TS2571 が 3 件。`c.cwd.startsWith(join(dataRoot, 'worktrees'))` が false で 1 件失敗

- [ ] **Step 2: 直す**

`server-mode.test.ts` は `await res.json()` を `as { code: string }` などの型にする。
`claude-code.test.ts:173` は両辺を `realpathSync` で実体パスにしてから比べる。

- [ ] **Step 3: 緑を確かめる**

Run: `pnpm typecheck && pnpm test`
Expected: すべて PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/server-mode.test.ts apps/api/src/claude-code.test.ts
git commit -m "test: 型エラーと Mac の /private/var の違いで落ちるテストを直す"
```

### Task 2: サーバーモードで危険な既定値を拒む

**Files:**
- Create: `apps/api/src/serverGuard.ts`
- Modify: `apps/api/src/server.ts`（`resolveAgentRuntime` の後に呼ぶ）
- Modify: `apps/api/src/agents/claude/detect.ts`（`--restricted` の有無を検出に足す）
- Modify: `apps/api/src/config.ts`（`ClaudeCodeConfig.detected` に `supportsRestricted: boolean`）
- Modify: `deploy/aws/paw.env.example:25`（`PAW_CLAUDE_CODE_RESTRICTED=1`）
- Test: `apps/api/src/server-guard.test.ts`

**Interfaces:**
- Produces: `assertSafeServerConfig(config: AppConfig): void` — 問題があれば、理由をすべて並べた `Error` を投げる。サーバーモードでなければ何もしない
- Produces: `detectRestrictedSupport(bin: string): Promise<boolean>` in `detect.ts` — `claude --help` の出力に `--restricted` があるか

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe('assertSafeServerConfig', () => {
  const safe = { publicUrl: 'https://paw.tailnet.ts.net', signup: 'first_user', seedDemo: false, enableDevRoutes: false,
    agentRuntime: 'claude_code', claudeCode: { restricted: true, detected: { supportsRestricted: true } } };
  it('サーバーモードで安全な設定なら通す', () => expect(() => assertSafeServerConfig(cfg(safe))).not.toThrow());
  it('ローカル（publicUrl なし）は何でも通す', () => expect(() => assertSafeServerConfig(cfg({ ...safe, publicUrl: null, signup: 'open', seedDemo: true }))).not.toThrow());
  it.each([
    [{ signup: 'open' }, 'PAW_SIGNUP'],
    [{ seedDemo: true }, 'PAW_SEED_DEMO'],
    [{ enableDevRoutes: true }, 'PAW_DEV_ROUTES'],
    [{ claudeCode: { restricted: false, detected: { supportsRestricted: true } } }, 'PAW_CLAUDE_CODE_RESTRICTED'],
    [{ claudeCode: { restricted: true, detected: { supportsRestricted: false } } }, '--restricted'],
  ])('%o は起動を拒む', (patch, word) => expect(() => assertSafeServerConfig(cfg({ ...safe, ...patch }))).toThrow(word));
  it('複数の問題をまとめて返す', () => expect(() => assertSafeServerConfig(cfg({ ...safe, signup: 'open', seedDemo: true }))).toThrow(/PAW_SIGNUP[\s\S]*PAW_SEED_DEMO/));
});
```

`cfg()` は `loadConfig({ dataDir: 'memory' })` に上書きを重ねるテスト内の小さな関数。`agentRuntime` が `claude_code` 以外のときは `--restricted` の 2 項目を見ない。

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/server-guard.test.ts`
Expected: FAIL（`serverGuard` が無い）

- [ ] **Step 3: 実装する**

`serverGuard.ts` に `assertSafeServerConfig` を書き、`server.ts` の `resolveAgentRuntime(config)` の直後で呼ぶ。`detect.ts` で `claude --help` を実行して `supportsRestricted` を埋める（`claude --version` と同じ `run` を使う）。`paw.env.example` の値を 1 にする。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/server-guard.test.ts src/server-mode.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/serverGuard.ts apps/api/src/server-guard.test.ts apps/api/src/server.ts apps/api/src/agents/claude/detect.ts apps/api/src/config.ts deploy/aws/paw.env.example
git commit -m "feat(api): サーバーモードで危険な既定値と --restricted 無しの起動を拒む"
```

### Task 3: worktree の作り直しと `.git` の改ざん検出

**Files:**
- Modify: `apps/api/src/agents/claude/git.ts`
- Modify: `apps/api/src/agents/claude/runner.ts`（AI の工程の後の git 操作の前に `assertGitLink` を呼ぶ）
- Test: `apps/api/src/worktree.test.ts`

**Interfaces:**
- Produces: `ensureWorktree(...)` は、`<path>` があって `<path>.base` か `<path>.gitlink` が無い、または `git -C <path> rev-parse` が失敗する worktree を、`git worktree remove --force` と `prune` の後に作り直す（引数は今と同じ）
- Produces: `Worktree` に `gitDir: string` を足す（`git rev-parse --absolute-git-dir` の値）
- Produces: `assertGitLink(wt: Worktree): Promise<void>` — `<path>/.git` の中身が `<path>.gitlink` に記録した中身と違えば `RunnerError('...', 'GIT_LINK_TAMPERED', false)`
- Produces: `changedPaths`・`commitAll`・`discardChanges`・`diffFromBase`・`headSha` は第 1 引数に `Worktree | string` を取り、`Worktree` のときは `--git-dir=<gitDir> --work-tree=<path>` を付けて実行する

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('.base が無い作りかけの worktree を作り直す', async () => {
  const wt = await ensureWorktree(repo, wtDir, 'run_a', 'ai/run-a');
  rmSync(`${wt.path}.base`);
  const again = await ensureWorktree(repo, wtDir, 'run_a', 'ai/run-a');
  expect(existsSync(`${again.path}.base`)).toBe(true);
  expect(await headSha(again)).toBe(again.baseSha);
});
it('.git ファイルの書き換えを検出する', async () => {
  const wt = await ensureWorktree(repo, wtDir, 'run_b', 'ai/run-b');
  writeFileSync(join(wt.path, '.git'), 'gitdir: /tmp/elsewhere\n');
  await expect(assertGitLink(wt)).rejects.toMatchObject({ code: 'GIT_LINK_TAMPERED' });
});
it('.git が書き換えられても changedPaths は本物の git を見る', async () => {
  const wt = await ensureWorktree(repo, wtDir, 'run_c', 'ai/run-c');
  writeFileSync(join(wt.path, 'a.txt'), 'x');
  writeFileSync(join(wt.path, '.git'), 'gitdir: /tmp/elsewhere\n');
  expect(await changedPaths(wt)).toContain('a.txt');
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/worktree.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`ensureWorktree` で worktree を作った直後に `.git` の中身を `<path>.gitlink` に書く。`removeWorktree` は `.gitlink` も消す。`runner.ts` の `implement` は `backend.develop` の直後、`verifyChanges` の前に `assertGitLink(wt)` を呼ぶ。`ensureWorktree` が返した `Worktree` を各工程に渡す。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/worktree.test.ts src/claude-code.test.ts src/claude.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agents/claude/git.ts apps/api/src/agents/claude/runner.ts apps/api/src/worktree.test.ts
git commit -m "fix(api): 作りかけの worktree を作り直し、.git の書き換えを検出する"
```

### Task 4: 中止で Claude CLI の終了を待つ／どの状態でもマージを受け付ける

**Files:**
- Modify: `apps/api/src/workflow/engine.ts`（`Inflight` に `done: Promise<void>`、`cancelRun`、`completeMergedRun`）
- Modify: `packages/contracts/src/index.ts`（`RUN_TRANSITIONS` に、終端以外から `approved` への遷移を足す）
- Test: `apps/api/src/claude-code.test.ts`、`apps/api/src/acceptance.test.ts`

**Interfaces:**
- Produces: `cancelRun(runId, reason)` は、その Run の実行中工程の `done` を最長 15 秒待ってから worktree を片付ける。戻り値は今と同じ
- Produces: `completeMergedRun(runId)` は、終端でないすべての状態で動く。実行中の工程を中止し（`cancelRun` と同じ待ち方）、未決の承認を `superseded` にして `approved` → `completed`

- [ ] **Step 1: 失敗するテストを書く**

`claude-code.test.ts` に「中止したとき、`cancelRun` が返る前に偽 CLI のプロセスが終わっている」テストを足す。偽 CLI は SIGINT を受けても 1 秒寝てから終わる設定にし、`cancelRun` の後に `process.kill(pid, 0)` が `ESRCH` を投げることを確かめる。

`acceptance.test.ts` に「`validating` の Run の PR がマージされたら `completed` になる」テストを足す（シミュレーターで `pull_request.closed`・`merged: true` を送る）。

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/claude-code.test.ts src/acceptance.test.ts`
Expected: 新しい 2 件が FAIL

- [ ] **Step 3: 実装する**

`Inflight` を登録するところで工程の実行 Promise を `done` に入れる。`cancelRun` は Run のロックの外で `done` を待つ（ロック内で待つと工程側の終了処理と詰まるため）。`transition` の終端処理で呼ぶ `cleanupRun` は、待ちが済んでから呼ぶよう順番を変える。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workflow/engine.ts packages/contracts/src/index.ts apps/api/src/claude-code.test.ts apps/api/src/acceptance.test.ts
git commit -m "fix(api): 中止は Claude CLI の終了を待ち、どの状態でも PR のマージで Run を終える"
```

### Task 5: GitHub API の操作を足す

**Files:**
- Modify: `apps/api/src/github/app.ts`
- Test: `apps/api/src/github-app.test.ts`（モックに経路を足す）

**Interfaces:**
- Produces（すべて `GithubApp` のメソッド。`fullName` は `owner/repo`。一覧は `per_page=100` で空の配列が返るまでページを進める）:
  - `listOpenIssues(installationId, fullName): Promise<GithubIssue[]>` — PR を除く
  - `listIssuesWithLabel(installationId, fullName, label): Promise<GithubIssue[]>`
  - `getIssue(installationId, fullName, number): Promise<GithubIssue>`
  - `listIssueComments(installationId, fullName, number): Promise<GithubComment[]>`
  - `lastLabeledBy(installationId, fullName, number, label): Promise<string | null>` — events API の最新の `labeled` のうち、そのラベルの actor の login
  - `addLabels(installationId, fullName, number, labels: string[]): Promise<void>`
  - `removeLabel(installationId, fullName, number, label): Promise<void>` — 404 は成功とみなす
  - `addAssignees(...)`・`removeAssignees(installationId, fullName, number, logins: string[]): Promise<void>`
  - `findOpenPullByHead(installationId, fullName, branch): Promise<GithubPullRequest | null>` — `GET /pulls?state=open&head=<owner>:<branch>`
  - `createPullRequest(installationId, fullName, { title, head, base, body }): Promise<GithubPullRequest>` — `draft: false`。`createDraftPullRequest` は消す
  - `getPull(installationId, fullName, number): Promise<{ state: 'open' | 'closed'; merged: boolean; headSha: string }>`
  - `listReviews(installationId, fullName, number): Promise<{ id: number; state: string; body: string; user: string; commitId: string }[]>`
- Produces: `GithubIssue = { number: number; title: string; body: string; htmlUrl: string; labels: string[]; assignees: string[]; updatedAt: string }`、`GithubComment = { id: number; body: string; user: string; userType: 'User' | 'Bot'; createdAt: string }`

- [ ] **Step 1: 失敗するテストを書く**

モックの GitHub に Issue 150 件（2 ページ）と、PR 1 件を混ぜた一覧を用意し、次を確かめる。

```ts
expect((await gh.listOpenIssues(INSTALLATION_ID, FULL_NAME)).length).toBe(150);
expect(await gh.lastLabeledBy(INSTALLATION_ID, FULL_NAME, 7, 'agents-office')).toBe('toshipy');
await gh.removeLabel(INSTALLATION_ID, FULL_NAME, 7, 'not-there'); // 404 でも投げない
const pr = await gh.createPullRequest(INSTALLATION_ID, FULL_NAME, { title: 't', head: 'ai/run-x', base: 'main', body: 'b' });
expect(requests.at(-1)!.body.draft).toBe(false);
expect(await gh.findOpenPullByHead(INSTALLATION_ID, FULL_NAME, 'ai/run-x')).toMatchObject({ number: pr.number });
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/github-app.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`request` を使う。ページングは `paginate<T>(path, installationId)` という private の関数に寄せる。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/github-app.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github/app.ts apps/api/src/github-app.test.ts
git commit -m "feat(api): Issue・ラベル・アサイン・PR・レビューの GitHub API 操作を足す"
```

### Task 6: PR は既存を探してから通常の PR で作る

**Files:**
- Modify: `apps/api/src/github/repoHost.ts:137-151`
- Modify: `apps/api/src/agents/claude/runner.ts`（`pullRequest` の本文・`draft` 表記）
- Modify: `apps/api/src/db/schema.ts`（`RunPr.draft` は `boolean` のまま、値は `false`）
- Test: `apps/api/src/github-app.test.ts`

**Interfaces:**
- Consumes: `findOpenPullByHead`・`createPullRequest`（Task 5）
- Produces: `RemoteRepoHost.publish` は、`existing` が無いとき `findOpenPullByHead` で探し、あればそれを返す。無ければ `createPullRequest`
- Produces: PR 本文の 1 行目は `Closes #<issueNumber>`（`ctx.issueNumber` があるとき）。末尾は「この PR は agents-office が作りました。マージは人が行います。」

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('PR 作成の再試行で既存の PR を使い、422 で失敗しない', async () => {
  // モック: 1 回目の POST /pulls は PR を作ってから 502 を返す。2 回目以降は 422（A pull request already exists）
  ...
  expect(run.status).toBe('waiting_review');
  expect(pulls.length).toBe(1);
  expect(pulls[0].draft).toBe(false);
  expect(pulls[0].body.split('\n')[0]).toBe('Closes #7');
});
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/github-app.test.ts`
Expected: FAIL（`GITHUB_REJECTED`）

- [ ] **Step 3: 実装する**

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/github-app.test.ts src/claude-code.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github/repoHost.ts apps/api/src/agents/claude/runner.ts apps/api/src/db/schema.ts apps/api/src/github-app.test.ts
git commit -m "fix(api): PR は既存を探してから通常の PR で作る"
```

### Task 7: AI のブランチへの人のコミットを取り込む

**Files:**
- Modify: `apps/api/src/github/repoHost.ts`（`syncBranch` を足す）
- Modify: `apps/api/src/agents/claude/runner.ts`（`implement` の revision > 0 で呼ぶ）
- Modify: `apps/api/src/workflow/engine.ts`（`BRANCH_DIVERGED` を `needs_input` にする）
- Test: `apps/api/src/github-app.test.ts`

**Interfaces:**
- Produces: `RemoteRepoHost.syncBranch(ctx, wt: Worktree, remote: RemoteRepo, branch: string): Promise<'up_to_date' | 'fast_forwarded'>` — `origin/<branch>` を fetch し、worktree の HEAD がその祖先なら fast-forward する。分岐していれば `RunnerError('...', 'BRANCH_DIVERGED', false)` を投げる
- Produces: `RunnerError` の `BRANCH_DIVERGED` は、エンジンが `failRun` ではなく `needs_input`（承認種別 `clarification`、`reason: 'branch_diverged'`）にする

- [ ] **Step 1: 失敗するテストを書く**

1. 人が `ai/run-*` に 1 コミット push してから changes_requested を送ると、`implement` の後のコミットの親が人のコミットになり、PR が更新される
2. 人のコミットと worktree のコミットが分岐していると、Run が `needs_input` になり、承認の `payload.reason` が `branch_diverged`

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/github-app.test.ts`
Expected: FAIL（push が non-fast-forward で `GIT_PUSH_FAILED`）

- [ ] **Step 3: 実装する**

fetch は `prepare` と同じ askpass の環境で行う。fast-forward は `git merge --ff-only`（Task 3 の `--git-dir` 付き）。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/github-app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github/repoHost.ts apps/api/src/agents/claude/runner.ts apps/api/src/workflow/engine.ts apps/api/src/github-app.test.ts
git commit -m "fix(api): AI のブランチに人が足したコミットを取り込み、分岐したら判断待ちにする"
```

### Task 8: Tester を Docker コンテナで動かす

**Files:**
- Create: `apps/api/src/agents/claude/testSandbox.ts`
- Modify: `apps/api/src/agents/claude/runner.ts:247-288`（`run(bin, args, ...)` を `sandbox.exec` に置き換える）
- Modify: `apps/api/src/config.ts`（`PAW_TEST_SANDBOX`・`PAW_TEST_IMAGE`・`PAW_TEST_NETWORK`）
- Modify: `apps/api/src/db/schema.ts`・`packages/contracts/src/index.ts`（`repository_bindings` に `testImage: text | null`。Drizzle のマイグレーションを足す）
- Modify: `apps/api/src/serverGuard.ts`（サーバーモードで `PAW_TEST_SANDBOX=host` を拒む）
- Test: `apps/api/src/test-sandbox.test.ts`

**Interfaces:**
- Produces: `interface TestSandbox { exec(cmd: string, args: string[], opts: { worktree: string; timeoutMs: number; signal: AbortSignal; image: string | null }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> }`
- Produces: `DockerSandbox`（`docker run --rm --network <PAW_TEST_NETWORK> -v <worktree>:/work -w /work --user <uid>:<gid> --env CI=1 <image> <cmd> <args...>`。`--env` は `CI` と `safeEnv` の `LANG`・`LC_ALL`・`TERM` だけ。他のホストのパスはマウントしない）と `HostSandbox`（今の `run` をそのまま使う）
- Produces: 設定の既定は、サーバーモードで `docker`、ローカルで `host`。`PAW_TEST_IMAGE` の既定は `node:22-bookworm`（コンテナ内で `corepack enable` が要る Repo は `testCommand` に書く）。`PAW_TEST_NETWORK` の既定は `paw-test`

- [ ] **Step 1: 失敗するテストを書く**

`DockerSandbox` には `docker` の実行を差し替える口（`spawnDocker`）を持たせ、渡した引数を検査する。

```ts
it('worktree だけをマウントし、秘密の環境変数を渡さない', async () => {
  process.env.PAW_SESSION_SECRET = 'x'; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'y';
  const calls: string[][] = [];
  const sb = new DockerSandbox({ network: 'paw-test', defaultImage: 'node:22-bookworm', spawnDocker: async (args) => { calls.push(args); return ok; } });
  await sb.exec('pnpm', ['test'], { worktree: '/var/lib/paw/worktrees/run_a', timeoutMs: 1000, signal, image: null });
  const a = calls[0];
  expect(a.filter((x) => x === '-v')).toHaveLength(1);
  expect(a[a.indexOf('-v') + 1]).toBe('/var/lib/paw/worktrees/run_a:/work');
  expect(a[a.indexOf('--network') + 1]).toBe('paw-test');
  expect(a.join(' ')).not.toMatch(/SECRET|TOKEN|OAUTH/);
  expect(a.slice(-3)).toEqual(['node:22-bookworm', 'pnpm', 'test']);
});
it('Docker が無いと TEST_SANDBOX_UNAVAILABLE で失敗する', ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/test-sandbox.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

中止（`signal`）では `docker kill <コンテナ名>` まで行う。コンテナ名は `paw-test-<runId>-<attempt>`。`ClaudeRunnerOptions` に `testSandbox: TestSandbox` を足し、`app.ts` で設定から組み立てる。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run && pnpm typecheck`
Expected: PASS（既存のテストは `HostSandbox` で動く）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agents/claude/testSandbox.ts apps/api/src/test-sandbox.test.ts apps/api/src/agents/claude/runner.ts apps/api/src/config.ts apps/api/src/app.ts apps/api/src/db/schema.ts apps/api/drizzle packages/contracts/src/index.ts apps/api/src/serverGuard.ts
git commit -m "feat(api): Tester を秘密の見えない Docker コンテナで動かす"
```

### Task 9: GitHub に書く前の `publish` 承認

**Files:**
- Modify: `packages/contracts/src/index.ts`（`APPROVAL_ACTION_TYPES` に `publish`、`APPROVAL_TYPE_LABEL` に「GitHub への書き込み」）
- Modify: `apps/api/src/workflow/engine.ts`（`advance` の review 成功時、`APPROVAL_TTL_MS.publish = 72h`）
- Modify: `apps/api/src/routes/approvals.ts`
- Modify: `apps/api/src/agents/claude/runner.ts`（`pullRequest` の冒頭で head を照合）
- Test: `apps/api/src/acceptance.test.ts`、`apps/api/src/github-app.test.ts`

**Interfaces:**
- Produces: review が通ると、エンジンは Run を `needs_input` にし、`publish` 承認を作る。`payload` は `{ kind: 'pull_request', headSha, diffSha256, title, body, labels: { remove: string[]; add: string[] }, update: boolean }`。digest はこの payload から作る（既存の `digestPayload`）
- Produces: 承認（approve）で `validating` に戻し、`draft_pr` か `update_pr` の工程を足す。差し戻しは `guidance` を付けて `running` にし `implement` を足す。却下は中止
- Produces: `pullRequest` 工程は、worktree の HEAD が承認した `headSha` と違えば push せず `RunnerError('...', 'PUBLISH_STALE', false)`。エンジンはこのとき承認を作り直す
- Produces: 画面からの指示の Run（Issue なし）とローカル Repo の Run も、同じ承認を通る

- [ ] **Step 1: 失敗するテストを書く**

1. `acceptance.test.ts`: review 成功後、Run は `needs_input`、承認は `publish`、GitHub への push はまだ無い。approve 後に `waiting_review` になる
2. 差し戻しで `implement` が再び動き、新しい `publish` 承認の `headSha` が変わる
3. `github-app.test.ts`: 承認前は `POST /pulls` と `git push` が 0 回
4. 承認と工程の間に worktree の HEAD を動かすと、push されず承認が作り直される

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/acceptance.test.ts src/github-app.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`approvals.ts` の `needs_input` 分岐で `ap.actionType === 'publish'` を先に扱い、`engine.resumeAfterPublish(runId, decision, comment)` を呼ぶ。`resumeAfterPublish` は engine に足す。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts apps/api/src/workflow/engine.ts apps/api/src/routes/approvals.ts apps/api/src/agents/claude/runner.ts apps/api/src/acceptance.test.ts apps/api/src/github-app.test.ts
git commit -m "feat(api): GitHub に push・PR を出す前に publish 承認を取る"
```

### Task 10: Webhook をやめて GitHub をポーリングする

**Files:**
- Create: `apps/api/src/github/poller.ts`
- Modify: `apps/api/src/config.ts`（`PAW_GITHUB_POLL_MS`、`PAW_GITHUB_LOGIN`、`PAW_GITHUB_WEBHOOK`。GitHub App 利用時に Webhook secret を必須にしない）
- Modify: `apps/api/src/app.ts`（`PAW_GITHUB_WEBHOOK=1` のときだけ `/integrations/github/webhook` を登録。`Services` に `poller`）
- Modify: `apps/api/src/server.ts`（`poller.start()`・`stop()`）
- Test: `apps/api/src/github-poller.test.ts`

**Interfaces:**
- Consumes: Task 5 の `listIssuesWithLabel`・`getPull`・`listReviews`
- Produces: `class GithubPoller { constructor(db: Db, github: GithubApp, intervalMs: number); start(): void; stop(): void; pollOnce(): Promise<void> }`
- Produces: `pollOnce` は `webhook_deliveries` に合成配信を積む。`provider: 'github_poll'`。`deliveryId` は次の形で、一意制約で重複を弾く
  - Issue: `poll:issue:<repositoryId>:<number>:<ラベルの付いた時刻 ISO>`。`eventType: 'issues'`、`action: 'labeled'`、`payload` は Webhook と同じ形（`issue`・`label: { name }`・`sender: { login: <lastLabeledBy の結果> }`）
  - レビュー: `poll:review:<repositoryId>:<pr>:<review id>`。`eventType: 'pull_request_review'`、`action: 'submitted'`
  - マージ／クローズ: `poll:pr:<repositoryId>:<pr>:closed`。`eventType: 'pull_request'`、`action: 'closed'`
- Produces: 対象は `automationEnabled` で `verification === 'github_app'` の Repo（Issue）と、PR を持つ終端でない Run（レビュー・マージ）
- Produces: `PAW_GITHUB_LOGIN` が未設定なら、`PAW_GITHUB_ALLOWED_USERS` の先頭を使う。どちらも無ければポーリングで Run を作らない（警告を出す）

- [ ] **Step 1: 失敗するテストを書く**

モックの GitHub を使い、`pollOnce` を 2 回呼んでも配信が 1 件であること、レビューが `waiting_review` の Run を `revising` に進めること、マージで `completed` になることを確かめる。`/integrations/github/webhook` が既定で 404 になることも確かめる。

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/github-poller.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

ラベルの付いた時刻は `lastLabeledBy` と同じ events 応答から取る（`lastLabeled(...)` が `{ login, at }` を返す形に Task 5 の関数を広げてよい）。一つの Repo の失敗は記録して次の Repo に進む。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github/poller.ts apps/api/src/github-poller.test.ts apps/api/src/config.ts apps/api/src/app.ts apps/api/src/server.ts
git commit -m "feat(api): Webhook をやめ、GitHub をポーリングして同じキューに積む"
```

### Task 11: Issue の入口（一覧・任せる・手動ラベル・アサイン）

**Files:**
- Create: `apps/api/src/github/issueIntake.ts`
- Create: `apps/api/src/routes/issues.ts`
- Modify: `apps/api/src/github/dispatcher.ts`（`onIssue` を `IssueIntake.start` に寄せる）
- Modify: `apps/api/src/routes/projects.ts:234`・`apps/api/src/seed.ts:41`・`apps/web/src/features/projects/ProjectsPage.tsx`（既定ラベルを `agents-office`）
- Modify: `apps/api/src/db/schema.ts`（`RunSource` に `assignedBySelf?: boolean`）
- Test: `apps/api/src/issue-intake.test.ts`

**Interfaces:**
- Consumes: Task 5 の GitHub 操作、Task 10 の合成配信
- Produces: `class IssueIntake { constructor(db, engine, github, login: string) }`
  - `list(projectId): Promise<{ candidates: IssueRow[]; materials: IssueRow[]; running: IssueRow[] }>` — `IssueRow = GithubIssue & { runId: string | null; skipReason: string | null }`。candidates は担当が `login` か未アサインで `nightly-ok`・`needs-human` の無いもの。materials は `needs-human` のもの。running は終端でない Run があるもの
  - `start(binding, issueNumber, opts: { via: 'ui' | 'label'; labeledBy: string | null; guidance: string | null }): Promise<{ runId: string } | { skipped: string }>`
- Produces: `start` の順序
  1. `via: 'label'` で `labeledBy` が `login` と違えば `skipped: 'labeled_by_other'`
  2. Issue を取り直す。担当に `login` 以外がいれば `skipped: 'assigned_to_other'`。`nightly-ok` があれば `skipped: 'nightly'`。終端でない Run があれば `skipped: 'duplicate_issue_run'`
  3. `via: 'ui'` なら `agents-office` を付ける。`needs-human` があれば外す
  4. 未アサインなら `login` をアサインし、取り直して `login` 以外も入っていれば自分を外して `skipped: 'assigned_concurrently'`
  5. コメントを取り、Run を作る（`request` に Issue 本文とコメント、`source.assignedBySelf`）
- Produces: API `GET /v1/projects/:id/issues` → `list` の結果。`POST /v1/projects/:id/issues/:number/delegate`（body `{ guidance?: string }`）→ `start(..., { via: 'ui', labeledBy: null, guidance })`
- Produces: 見送りは `webhook.ignored` のイベントに理由を載せる（画面の Run 一覧の横に出る既存の表示を使う）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it.each([
  ['他人がラベルを付けた', { via: 'label', labeledBy: 'someone' }, 'labeled_by_other'],
  ['他人が担当', { assignees: ['someone'] }, 'assigned_to_other'],
  ['nightly-ok が付いている', { labels: ['nightly-ok'] }, 'nightly'],
])('%s は見送る', ...);
it('画面から任せるとラベルとアサインを付けて Run を作る', ...);   // addLabels(['agents-office'])・addAssignees(['toshipy'])
it('資料済みの Issue を選ぶと needs-human を外して始める', ...);
it('同じ Issue に二度任せても Run は 1 件', ...);
it('一覧は 3 つの欄に分かれ、PR と nightly-ok を出さない', ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/issue-intake.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`Dispatcher.onIssue` の予算・停止中・Project 状態の確認は残し、Run 作成の部分を `IssueIntake.start` に置き換える。合成配信の `sender.login` を `labeledBy` として渡す。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run && pnpm typecheck`
Expected: PASS（`ai:ready` を使う既存テストは `agents-office` に直す）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github/issueIntake.ts apps/api/src/routes/issues.ts apps/api/src/issue-intake.test.ts apps/api/src/github/dispatcher.ts apps/api/src/routes/projects.ts apps/api/src/seed.ts apps/api/src/db/schema.ts apps/api/src/app.ts apps/web/src/features/projects/ProjectsPage.tsx apps/api/src/acceptance.test.ts apps/api/src/github-app.test.ts
git commit -m "feat(api): Issue を一覧・選択・手動ラベルで受け、着手時に自分をアサインする"
```

### Task 12: 資料モード

**Files:**
- Create: `apps/api/src/agents/claude/materials.ts`
- Modify: `apps/api/src/agents/claude/shared.ts`（`PlanOutput` に `mode: 'implement' | 'materials'`・`mode_reason: string`。`ReviewOutput` に `needs_design_decision: boolean`。`MATERIALS_SYSTEM`）
- Modify: `apps/api/src/agents/claude/runner.ts`（`materials` と `post_materials` の工程）
- Modify: `packages/contracts/src/index.ts`（`STEP_KEYS` に `materials`・`post_materials`）
- Modify: `apps/api/src/workflow/engine.ts`（振り分け・切り替え・`publish` の `kind: 'materials'`）
- Test: `apps/api/src/materials.test.ts`

**Interfaces:**
- Produces: `decideFromComments(comments: GithubComment[]): 'implement' | null` in `materials.ts` — 1 行目が `<!-- nightly-materials -->` のコメントがあり、最新のその後に `userType !== 'Bot'` で 1 行目がその印でないコメントがあれば `'implement'`。それ以外は `null`（Planner に任せる）
- Produces: `MATERIALS_MARKER = '<!-- nightly-materials -->'`、`MATERIALS_HEADINGS = ['## 決めること', '## 現状', '## 選択肢', '## 会議で確かめる問い']`
- Produces: `validateMaterials(md: string): string[]` — 1 行目の印、見出しの順、`## 推奨` 等の見出しが無いことを確かめ、問題を返す
- Produces: 流れ
  - plan の `mode` が `materials`（`decideFromComments` が `implement` のときは無視）→ `materials` 工程（読み取り専用ツール、構造化出力 `{ markdown: string }`）→ `validateMaterials` が空でなければ 1 回だけ作り直し、それでも駄目なら失敗 → `publish` 承認（`kind: 'materials'`、`comment`、`labels: { remove: ['agents-office'], add: ['needs-human'] }`、`unassign: source.assignedBySelf`）→ 承認で `post_materials` → `completed`
  - Developer の要約に `NEEDS_DESIGN_DECISION:` の行がある、または review の `needs_design_decision` が true → 変更を捨てて `materials` 工程へ。ただし `run.pr` がある、または Issue の無い Run は `needs_input`（`clarification`、`reason: 'needs_design_decision'`）
  - `post_materials` は、投稿の前に同じ Run の印付きコメント（本文に `run: <runId>` を含む）があれば投稿を省く
- Produces: Issue の無い Run では、plan の `mode` は常に `implement` として扱う

- [ ] **Step 1: 失敗するテストを書く**

`decideFromComments` と `validateMaterials` の表形式テスト（Bot のコメントは数えない、印だけのコメントは数えない、`## 推奨` があれば問題）と、偽 CLI で plan が `materials` を返したときに「`publish` 承認 → コメント 1 件・`agents-office` を外す・`needs-human` を付ける・`completed`」になる流れのテスト。再起動で `post_materials` が 2 回動いてもコメントは 1 件。

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/materials.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`MATERIALS_SYSTEM` は yulong の `.agents/nightly-issue-pr.md` の「資料を書く」を要約して書く（各見出しの中身の指示、推奨や結論を書かない、Mermaid は可）。

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/agents/claude/materials.ts apps/api/src/agents/claude/shared.ts apps/api/src/agents/claude/runner.ts packages/contracts/src/index.ts apps/api/src/workflow/engine.ts apps/api/src/materials.test.ts
git commit -m "feat(api): 人が決める Issue には判断材料を Issue コメントに書く資料モードを足す"
```

### Task 13: Run の終わりのラベルとアサインの片付け

**Files:**
- Create: `apps/api/src/github/issueCleanup.ts`
- Modify: `apps/api/src/agents/claude/runner.ts`（`pullRequest` の PR 作成後に `agents-office` を外す）
- Modify: `apps/api/src/workflow/engine.ts`（`cleanupRun` で、失敗・中止の Run に `IssueCleanup.onAbandoned` を呼ぶ）
- Test: `apps/api/src/issue-intake.test.ts`

**Interfaces:**
- Produces: `IssueCleanup.onAbandoned(run: RunRow): Promise<void>` — `source.type === 'github_issue'` のとき `agents-office` を外し、`source.assignedBySelf` なら自分のアサインを外す。Issue にコメントは書かない。GitHub の失敗はログだけ残して投げない
- Produces: PR を作ったときは `agents-office` だけ外す（アサインは残す）。資料のときは Task 12 の `post_materials` が行う

- [ ] **Step 1: 失敗するテストを書く**

失敗・中止・PR 作成・資料のそれぞれで、モックの GitHub に届いたラベルとアサインの操作を確かめる。失敗では `POST /issues/:n/comments` が 0 回。

- [ ] **Step 2〜4: 失敗を確かめ、実装し、緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/issue-intake.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github/issueCleanup.ts apps/api/src/agents/claude/runner.ts apps/api/src/workflow/engine.ts apps/api/src/issue-intake.test.ts
git commit -m "feat(api): Run の終わりに agents-office ラベルと自分のアサインを片付ける"
```

### Task 14: 画面（Issue 一覧と publish 承認）

**Files:**
- Create: `apps/web/src/features/projects/IssuePanel.tsx`
- Modify: `apps/web/src/features/projects/ProjectsPage.tsx`（GitHub App で接続した Project に `IssuePanel` を出す）
- Modify: `apps/web/src/features/approvals/ApprovalCard.tsx`（`publish` の表示と承認・差し戻し・却下）
- Modify: `apps/web/src/shared/api/client.ts`（`listIssues`・`delegateIssue`）
- Modify: `apps/web/src/demo/mockBackend.ts`（デモビルドが壊れない程度に同じ API を返す）

**Interfaces:**
- Consumes: Task 11 の API、Task 9・12 の `publish` 承認の payload
- Produces: `IssuePanel` は「候補」「資料済み」「実行中」の 3 欄。候補と資料済みの各行に「AI に任せる」ボタンと、開くと出る追加指示の欄。実行中は Run 詳細へのリンク。見送り理由があれば行に出す
- Produces: `publish` の承認カードは、`kind: 'pull_request'` で PR のタイトル・本文・差分（既存の差分成果物へのリンク）・テスト結果、`kind: 'materials'` でコメント本文（Markdown をそのまま `pre` で）とラベル操作を出す

- [ ] **Step 1: 型を確かめる**

Run: `pnpm --filter @paw/web exec tsc -p tsconfig.json`
Expected: PASS

- [ ] **Step 2: 画面で確かめる**

Run: `pnpm dev`。シミュレーターの Project では `IssuePanel` が出ないこと、承認画面に `publish` のカードが出て承認・差し戻しが動くことを、ブラウザで確かめる（ローカル Repo の Run で review まで通す）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/projects/IssuePanel.tsx apps/web/src/features/projects/ProjectsPage.tsx apps/web/src/features/approvals/ApprovalCard.tsx apps/web/src/shared/api/client.ts apps/web/src/demo/mockBackend.ts
git commit -m "feat(web): 案件ごとの Issue 一覧と、GitHub への書き込み承認の画面を足す"
```

### Task 15: 常時動かす手順（EC2・Tailscale・Docker）

**Files:**
- Modify: `deploy/aws/terraform/scripts/bootstrap.sh`（Funnel → `tailscale serve --bg --https=443 http://127.0.0.1:8787`、Docker を入れて `paw` を `docker` グループへ、`paw-test` ネットワークと `DOCKER-USER` の規則、`PAW_TEST_SANDBOX=docker`）
- Create: `deploy/aws/paw-test-network.sh`（ネットワークと iptables 規則を作る。起動のたびに systemd から呼ぶ）
- Modify: `deploy/aws/paw.service`（`ExecStartPre` で上のスクリプト）
- Modify: `deploy/aws/paw.env.example`（`PAW_GITHUB_LOGIN`、`PAW_GITHUB_POLL_MS=60000`、Webhook secret の行を消す）
- Modify: `deploy/aws/README.md`・`deploy/aws/terraform/README.md`・`README.md`（GitHub App の作り方は「agents-office 専用・Contents/Pull requests/Issues の書き込み・Metadata の読み取り・Webhook は無効」、起動後の確認手順）

**Interfaces:**
- Produces: `DOCKER-USER` で、`paw-test` ネットワークの送信元から `10.0.0.0/8`・`172.16.0.0/12`・`192.168.0.0/16`・`169.254.0.0/16`・`100.64.0.0/10` とホストのアドレスへの通信を `DROP`

- [ ] **Step 1: スクリプトを検査する**

Run: `bash -n deploy/aws/terraform/scripts/bootstrap.sh deploy/aws/paw-test-network.sh && shellcheck deploy/aws/paw-test-network.sh`
Expected: エラーなし（shellcheck が無ければ `bash -n` だけ）

- [ ] **Step 2: Terraform を検査する**

Run: `cd deploy/aws/terraform && terraform fmt -check && terraform validate`
Expected: PASS（`terraform init -backend=false` が要れば先に行う）

- [ ] **Step 3: Commit**

```bash
git add deploy/aws/terraform/scripts/bootstrap.sh deploy/aws/paw-test-network.sh deploy/aws/paw.service deploy/aws/paw.env.example deploy/aws/README.md deploy/aws/terraform/README.md README.md
git commit -m "feat(deploy): Funnel をやめて tailnet 内だけで公開し、Tester 用の Docker と通信制限を入れる"
```

### Task 16: meeting-note の夜間候補から除外する（別リポジトリ）

**Files（fenrir-inc/meeting-note）:**
- Modify: `packages/core/src/teamOps/grooming/nightly.ts:9`（`NIGHTLY_SKIP_LABELS` に `"agents-office"`）
- Test: `packages/core/test/` の nightly のテスト（既存のファイルに 1 件）

- [ ] **Step 1: 失敗するテストを書く**（`agents-office` の付いた Issue が `nightlyTargets` から外れる）
- [ ] **Step 2: 失敗を確かめる**（`pnpm --filter @meet-minutes-bot/core exec vitest run test/<nightly のテスト>`）
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `pnpm verify` を緑にする**
- [ ] **Step 5: Commit し、meeting-note の PR を出す**（コメントの「任せた（nightly-ok）か、人の判断に戻した（needs-human）」に agents-office を足す）

### Task 17: 全体の検証と実 Issue での確認

前提: agents-office 専用の GitHub App が作られ、対象リポジトリに入っている（ユーザーの作業）。

- [ ] **Step 1: 全体の検証**

Run: `pnpm typecheck && pnpm test`
Expected: すべて PASS

- [ ] **Step 2: ローカルで実 GitHub につなぐ**

`.env` 相当の環境変数で `PAW_GITHUB_APP_ID`・`PAW_GITHUB_APP_PRIVATE_KEY_FILE`・`PAW_GITHUB_LOGIN=Toshipy`・`PAW_TEST_SANDBOX=docker` を設定して `pnpm start`。Project に対象リポジトリを接続し、自動起動を ON にする

- [ ] **Step 3: 実装の Issue を 1 件通す**

小さな Issue を画面の「AI に任せる」で選ぶ。`publish` 承認の内容を確かめて承認し、通常の PR（`Closes #N`）ができ、`agents-office` ラベルが外れたことを GitHub で確かめる

- [ ] **Step 4: 資料の Issue を 1 件通す（あれば）**

「検討」を含む Issue で、資料コメント・`needs-human`・ラベルの付け外しを確かめる

- [ ] **Step 5: EC2 で動かす**

Task 15 の手順で立て、tailnet の外から URL に届かないこと（`curl` が名前解決できない、または接続できない）と、tailnet 内から画面が開けることを確かめる
