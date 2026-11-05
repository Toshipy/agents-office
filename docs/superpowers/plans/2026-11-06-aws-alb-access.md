# 社内 VPN と Google ログインで開く常時運用 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agents-office を `cloud-skuld` の EC2 で動かし、社内 VPN の出口 IP からだけ届く ALB と Google ログインを通して、t.arai だけが `https://agents-office.c.fnrr.biz` で使えるようにする。

**Architecture:** ALB が HTTPS（ACM）と Google の OIDC ログインを受け持ち、ログインした人の署名付き JWT を `x-amzn-oidc-data` でアプリに渡す。アプリは新しい認証モード `alb_oidc` でその JWT を毎回確かめ、許可した 1 人だけを通す。GitHub のポーリングは平日 9〜19 時（JST）だけ 15 分おきに動く。

**Tech Stack:** TypeScript（Hono・Drizzle・vitest）、React 19、Node の `crypto`（ES256 の検証）、Terraform（AWS プロバイダー 5.x、2 つのプロバイダー）。

**Spec:** `docs/superpowers/specs/2026-11-06-aws-alb-access-design.md`（前提の設計は `docs/superpowers/specs/2026-11-02-issue-runner-design.md`）

## Global Constraints

- ドメインは `agents-office.c.fnrr.biz`。DNS は `cloud-common` の公開ゾーン `c.fnrr.biz`。EC2・ALB・ACM は `cloud-skuld`（リージョン `ap-northeast-1`）
- ALB の受信は `allowed_cidrs` からの 443 番だけ。80 番は開けない。EC2 の受信は ALB のセキュリティグループからの 8787 番だけ
- ALB の OIDC は Google（issuer `https://accounts.google.com`、scope `openid email profile`、セッション 604800 秒）。アイドルタイムアウトは 300 秒
- ALB のヘルスチェックは `GET /v1/health`
- アプリの認証モードは `PAW_AUTH=alb_oidc`。必須の設定は `PAW_ALB_ARN` と `PAW_ALLOWED_EMAIL`（t.arai@fenrir.co.jp）
- JWT は毎回確かめる。アプリ独自のセッション Cookie は `alb_oidc` では使わない
- ポーリングの時間帯 `PAW_GITHUB_POLL_WINDOW` の既定は `Mon-Fri 09:00-19:00 Asia/Tokyo`。開始を含み終了を含まない。`always` で制限なし。`PAW_GITHUB_POLL_MS` の既定は 900000
- Tailscale は使わない（導入・設定・SSM の認証キー・変数をすべて消す）
- EC2 の IAM ロールは SSM の `${ssm_prefix}/*` を読むことと SSM でのログインだけ。`ssm_prefix` の既定は `/agents-office`
- import は拡張子なし（既存どおり）。コメントは日本語。`git add` はファイル単位
- 完了の条件は `pnpm typecheck` と `pnpm test` が緑、Terraform は `terraform fmt -check` と `terraform validate` が通ること

## Review Focus

- ALB の JWT の base64 に末尾の `=` が付くことがある（ALB の既知の癖）→ 末尾の `=` を外してから検証する。Task 1 にテストを置く
- 許可していないメールでログインした人が 401 を受けて、Web が読み直しを繰り返す → 401 は「このアカウントでは使えません」の画面を出し、読み直さない。Task 3 にテストを置く
- ALB の公開鍵の取得に失敗する、または未知の `kid` → 401 にし、例外でプロセスを落とさない。Task 1 にテストを置く
- 時間帯の境界（9:00 ちょうど・19:00 ちょうど・土日・日本時間とサーバーの UTC のずれ）→ 9:00 は対象、19:00 は対象外、UTC のサーバーでも日本時間で判定する。Task 4 にテストを置く
- `alb_oidc` なのにヘッダーが無い要求（ALB を通らない直の要求）→ 401。Task 2 にテストを置く

---

### Task 1: ALB の JWT を確かめる

**Files:**
- Create: `apps/api/src/auth/albOidc.ts`
- Test: `apps/api/src/alb-oidc.test.ts`

**Interfaces:**
- Produces: `interface AlbIdentity { email: string; name: string | null }`
- Produces: `type AlbKeyFetcher = (kid: string) => Promise<string>`（PEM の公開鍵を返す）
- Produces: `function albPublicKeyFetcher(region: string, fetchImpl?: typeof fetch): AlbKeyFetcher` — `https://public-keys.auth.elb.${region}.amazonaws.com/${kid}` を取得し、`kid` ごとにメモリでキャッシュする。`kid` は `/^[0-9a-f-]{36}$/i` 以外を拒む
- Produces: `async function verifyAlbOidc(token: string | undefined, opts: { albArn: string; allowedEmail: string; fetchKey: AlbKeyFetcher; now?: number }): Promise<{ ok: true; identity: AlbIdentity } | { ok: false; reason: 'missing' | 'malformed' | 'bad_signature' | 'wrong_signer' | 'expired' | 'unverified_email' | 'not_allowed' | 'key_unavailable' }>`
  - ヘッダーの JSON: `alg` が `ES256`、`signer` が `albArn` と一致、`exp`（秒）が `now` より後
  - ペイロード: `email` を小文字にして `allowedEmail`（小文字）と一致。`email_verified === false` なら `unverified_email`
  - 署名は Node の `crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)`
  - 各部の末尾の `=` を外してから base64url として読む

- [ ] **Step 1: 失敗するテストを書く**

テスト内で `generateKeyPairSync('ec', { namedCurve: 'P-256' })` の鍵を作り、ALB と同じ形の JWT を作る小さな関数（`signAlbJwt(header, payload, privateKey, { padding?: boolean })`）を置く。`fetchKey` はその公開鍵の PEM を返す偽物にする。

```ts
it.each([
  ['正しい JWT', {}, { ok: true }],
  ['末尾に = が付いた JWT', { padding: true }, { ok: true }],
  ['署名が違う', { tamper: true }, { ok: false, reason: 'bad_signature' }],
  ['signer が別の ALB', { header: { signer: 'arn:aws:elasticloadbalancing:ap-northeast-1:1:loadbalancer/app/other/x' } }, { ok: false, reason: 'wrong_signer' }],
  ['期限切れ', { header: { exp: NOW / 1000 - 1 } }, { ok: false, reason: 'expired' }],
  ['別のメール', { payload: { email: 'someone@fenrir.co.jp' } }, { ok: false, reason: 'not_allowed' }],
  ['大文字のメール', { payload: { email: 'T.Arai@Fenrir.co.jp' } }, { ok: true }],
  ['未確認のメール', { payload: { email_verified: false } }, { ok: false, reason: 'unverified_email' }],
  ['alg が ES256 でない', { header: { alg: 'HS256' } }, { ok: false, reason: 'malformed' }],
])('%s', ...);
it('ヘッダーが無ければ missing', ...);
it('3 つに分かれない文字列は malformed', ...);
it('鍵の取得に失敗したら key_unavailable で、例外を投げない', ...);
it('albPublicKeyFetcher は同じ kid を 2 回目は取りに行かず、不正な kid を拒む', ...);
```

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/alb-oidc.test.ts`
Expected: FAIL（モジュールが無い）

- [ ] **Step 3: 実装する**

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/alb-oidc.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/albOidc.ts apps/api/src/alb-oidc.test.ts
git commit -m "feat(api): ALB が渡す Google ログインの JWT を確かめる"
```

### Task 2: `alb_oidc` の認証モードとサーバーの検査

**Files:**
- Modify: `apps/api/src/config.ts`（`auth: 'local' | 'alb_oidc'`、`albArn: string | null`、`allowedEmail: string | null`、`awsRegion: string`）
- Modify: `apps/api/src/auth/session.ts`（`resolveAuth`）
- Modify: `apps/api/src/routes/auth.ts`（config・login・signup・logout）
- Modify: `apps/api/src/services/provision.ts`（メールでユーザーを用意する関数）
- Modify: `apps/api/src/serverGuard.ts`
- Modify: `apps/api/src/app.ts`（`albPublicKeyFetcher` の組み立て。テストで差し替えられるよう `createServices` の opts に `albKeyFetcher?: AlbKeyFetcher`）
- Test: `apps/api/src/alb-auth-mode.test.ts`、`apps/api/src/server-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 の `verifyAlbOidc`、`albPublicKeyFetcher`、`AlbIdentity`
- Produces: 設定 `PAW_AUTH`（`local` 既定 / `alb_oidc`）、`PAW_ALB_ARN`、`PAW_ALLOWED_EMAIL`、`PAW_AWS_REGION`（既定 `ap-northeast-1`）
- Produces: `async function ensureEmailUser(db: Db, email: string, displayName: string | null): Promise<{ userId: string; workspaceId: string }>` in `provision.ts` — `username` はメールの小文字、`passwordHash` は `'!alb_oidc'`（`verifyPassword` が必ず false を返す値であることをテストで確かめる）。既にあればそれを返す。同時の初回要求で 2 人できないよう、`username` の一意制約の衝突は取り直しで吸収する
- Produces: `alb_oidc` の `resolveAuth` は `x-amzn-oidc-data` を `verifyAlbOidc` で確かめ、`ensureEmailUser` の結果から `AuthContext` を返す。セッション Cookie は見ない
- Produces: `GET /v1/auth/config` は `alb_oidc` のとき `{ mode: 'alb_oidc', devRoutes: false, signup: false, signupCodeRequired: false, devAccounts: [] }`
- Produces: `alb_oidc` では `POST /v1/auth/login` と `POST /v1/auth/signup` が 404（`AUTH_MODE_ALB`）。`POST /v1/auth/logout` は `AWSELBAuthSessionCookie-0` から `-3` を `Max-Age=0; Path=/; Secure` で消し、`{ ok: true }`
- Produces: `GET /v1/auth/me`（既存の自分の情報の取得経路。無ければ既存の名前に合わせる）は `alb_oidc` でも JWT から通る
- Produces: serverGuard は、`publicUrl` があるとき次を拒む: `auth !== 'alb_oidc'`、`albArn` が無い、`allowedEmail` が無い。`auth === 'alb_oidc'` のときは `PAW_SIGNUP` の検査を外す

- [ ] **Step 1: 失敗するテストを書く**

`alb-auth-mode.test.ts`（`loadConfig({ dataDir: 'memory', auth: 'alb_oidc', albArn: ARN, allowedEmail: 't.arai@fenrir.co.jp' })` と、Task 1 のテストと同じ署名関数・偽の `albKeyFetcher`）:

```ts
it('ヘッダーが無い /v1 の要求は 401', ...);
it('正しい JWT で初めて来た人のユーザーとワークスペースが作られ、2 回目は同じユーザー', ...);
it('同時に 2 つの初回要求が来てもユーザーは 1 人', ...);
it('許可していないメールは 401', ...);
it('/v1/auth/config は alb_oidc を返し、デモアカウントを返さない', ...);
it('login と signup は 404', ...);
it('logout は ALB の Cookie を消す', ...); // set-cookie に AWSELBAuthSessionCookie-0=; Max-Age=0
it('更新系は x-paw-client と Origin の検査が今までどおり効く', ...);
it('作られたユーザーのパスワードではログインできない（passwordHash が使えない値）', ...);
```

`server-guard.test.ts` に 3 件（`auth: 'local'` のサーバー・ARN 無し・メール無しを拒む）と、`alb_oidc` なら `signup: 'open'` でも拒まない 1 件を足す。既存の「安全な設定」は `auth: 'alb_oidc'` などを足して通るようにする。

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/alb-auth-mode.test.ts src/server-guard.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm typecheck && pnpm test`
Expected: すべて PASS（`server-mode.test.ts` など既存のローカルモードの試験は変わらず通る）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/auth/session.ts apps/api/src/routes/auth.ts apps/api/src/services/provision.ts apps/api/src/serverGuard.ts apps/api/src/app.ts apps/api/src/alb-auth-mode.test.ts apps/api/src/server-guard.test.ts
git commit -m "feat(api): ALB の Google ログインだけで入る認証モードを足し、サーバーではそれを必須にする"
```

### Task 3: Web の `alb_oidc` 対応

**Files:**
- Modify: `apps/web/src/shared/api/authConfig.ts`、`apps/web/src/app/App.tsx`、`apps/web/src/features/auth/LoginPage.tsx`、`apps/web/src/shared/api/client.ts`
- Create: `apps/web/src/features/auth/NotAllowedPage.tsx`

**Interfaces:**
- Consumes: Task 2 の `/v1/auth/config` の `mode: 'alb_oidc'`、logout の挙動
- Produces: `alb_oidc` のとき
  - ログイン画面を出さない。自分の情報の取得が 401 なら `NotAllowedPage`（「このアカウントでは使えません」と、サインアウトのボタン）を出し、読み直さない
  - API の fetch が `TypeError`（ALB のログイン切れでリダイレクトされ、CORS で失敗した状態）で失敗したら、ページを読み直す。`sessionStorage` に最後に読み直した時刻を置き、60 秒以内には繰り返さない
  - サインアウトは `POST /v1/auth/logout` の後に `location.assign('/')`
- `local` / `server` の表示は今と同じ

- [ ] **Step 1: 型を確かめる**

Run: `pnpm --filter @paw/web exec tsc -p tsconfig.json && pnpm --filter @paw/web build`
Expected: PASS

- [ ] **Step 2: 画面で確かめる**

`PAW_AUTH=alb_oidc` でローカルに起動し、ヘッダーを付けない状態で開くと `NotAllowedPage` が出て、読み直しを繰り返さないことをブラウザで確かめる（ALB が無い環境では 401 になるため）。`local` の起動ではログイン画面が今までどおり出ることも確かめる。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/shared/api/authConfig.ts apps/web/src/app/App.tsx apps/web/src/features/auth/LoginPage.tsx apps/web/src/shared/api/client.ts apps/web/src/features/auth/NotAllowedPage.tsx
git commit -m "feat(web): ALB の Google ログインのときはログイン画面を出さず、許可外は案内を出す"
```

### Task 4: ポーリングの時間帯

**Files:**
- Create: `apps/api/src/github/pollWindow.ts`
- Modify: `apps/api/src/github/poller.ts`（`pollOnce` の冒頭、`start()` の最初の 1 回も含む）
- Modify: `apps/api/src/config.ts`（`githubPollWindow: PollWindow | 'always'`、`PAW_GITHUB_POLL_MS` の既定を 900000）
- Test: `apps/api/src/poll-window.test.ts`、`apps/api/src/github-poller.test.ts`

**Interfaces:**
- Produces: `interface PollWindow { days: number[]; startMinute: number; endMinute: number; timeZone: string }`（`days` は 0=日〜6=土）
- Produces: `function parsePollWindow(v: string | undefined): PollWindow | 'always'` — 既定 `Mon-Fri 09:00-19:00 Asia/Tokyo`。曜日は `Mon`〜`Sun` の範囲（`Mon-Fri`）か列挙（`Mon,Wed`）。解析できなければ起動時に例外
- Produces: `function inPollWindow(at: Date, w: PollWindow | 'always'): boolean` — `Intl.DateTimeFormat` の `timeZone` で曜日と時刻を出す。`startMinute <= m < endMinute`
- Produces: `GithubPoller` は時間帯の外では `pollOnce` を何もせず終える（ログはデバッグ水準で 1 行）。`GithubPoller` の constructor に `window: PollWindow | 'always'` と `now?: () => Date` を足す

- [ ] **Step 1: 失敗するテストを書く**

```ts
const W = parsePollWindow('Mon-Fri 09:00-19:00 Asia/Tokyo');
it.each([
  ['2026-11-09T00:00:00Z', true],   // 月 9:00 JST（開始を含む）
  ['2026-11-08T23:59:00Z', false],  // 月 8:59 JST
  ['2026-11-09T09:59:00Z', true],   // 月 18:59 JST
  ['2026-11-09T10:00:00Z', false],  // 月 19:00 JST（終了を含まない）
  ['2026-11-14T03:00:00Z', false],  // 土 12:00 JST
  ['2026-11-13T03:00:00Z', true],   // 金 12:00 JST
])('%s → %s', (iso, expected) => expect(inPollWindow(new Date(iso), W)).toBe(expected));
it('always は常に true', ...);
it('不正な書式は例外', ...);
```

`github-poller.test.ts` に「時間帯の外では GitHub に問い合わせない（モックへの要求が 0）」「`always` なら問い合わせる」を足す。既存のポーラーの試験は `always` で動かす。

- [ ] **Step 2: 失敗を確かめる**

Run: `pnpm --filter @paw/api exec vitest run src/poll-window.test.ts src/github-poller.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

- [ ] **Step 4: 緑を確かめる**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/github/pollWindow.ts apps/api/src/github/poller.ts apps/api/src/config.ts apps/api/src/poll-window.test.ts apps/api/src/github-poller.test.ts
git commit -m "feat(api): GitHub のポーリングを平日 9〜19 時だけ 15 分おきにする"
```

### Task 5: Terraform（ALB・証明書・DNS・EC2）

**Files:**
- Modify: `deploy/aws/terraform/versions.tf`（`aws.dns` プロバイダー: `profile = var.dns_profile`、同じ `region`）
- Modify: `deploy/aws/terraform/variables.tf`
- Modify: `deploy/aws/terraform/main.tf`（2 つ目のパブリックサブネット、ALB とそのセキュリティグループ、ターゲットグループ、リスナー、ACM、Route 53 のレコード、EC2 のセキュリティグループの受信、bootstrap に渡す値）
- Modify: `deploy/aws/terraform/outputs.tf`
- Modify: `deploy/aws/terraform/scripts/bootstrap.sh`（Tailscale を消し、`paw.env` に新しい設定を書く）
- Modify: `deploy/aws/terraform/terraform.tfvars.example`、`deploy/aws/paw.env.example`

**Interfaces:**
- Produces（変数）: `allowed_cidrs`（list(string)、必須、空は不可）、`domain_name`（既定 `agents-office.c.fnrr.biz`）、`dns_zone_name`（既定 `c.fnrr.biz`）、`dns_profile`（既定 `cloud-common`）、`manage_dns`（bool、既定 true）、`allowed_email`（既定 `t.arai@fenrir.co.jp`）、`google_client_id_param`・`google_client_secret_param`（SSM のパラメーター名。既定 `${ssm_prefix}/google_client_id`・`${ssm_prefix}/google_client_secret`）。`ssm_prefix` の既定は `/agents-office`。`tailscale_hostname` は消す
- Produces（リソース）:
  - ALB: `internal = false`、2 つの AZ のパブリックサブネット、`idle_timeout = 300`、`drop_invalid_header_fields = true`
  - ALB のセキュリティグループ: 受信は `allowed_cidrs` からの 443 番だけ。送信は EC2 のセキュリティグループへの 8787 番だけ
  - EC2 のセキュリティグループ: 受信は ALB のセキュリティグループからの 8787 番だけを足す（送信は今のまま）
  - ターゲットグループ: 8787、HTTP、ヘルスチェック `GET /v1/health`、成功 200
  - リスナー 443: 証明書は ACM、`ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"`、既定のアクションは `authenticate-oidc`（Google の 4 つのエンドポイント: `https://accounts.google.com`・`https://accounts.google.com/o/oauth2/v2/auth`・`https://oauth2.googleapis.com/token`・`https://openidconnect.googleapis.com/v1/userinfo`、scope `openid email profile`、`session_timeout = 604800`、`on_unauthenticated_request = "authenticate"`）の後に `forward`
  - ACM: `domain_name`、DNS 検証。`manage_dns = true` なら検証用 CNAME と `domain_name` → ALB の CNAME を `aws.dns` で `dns_zone_name` に作り、`aws_acm_certificate_validation` で待つ
  - `manage_dns = false` なら Route 53 のリソースと検証の待ちを作らない（`count`）。リスナーは証明書の検証が済むまで作れないので、README の 2 段階手順（1 回目は `-target=aws_acm_certificate.this`、手で CNAME を登録、2 回目に全部）で使う
- Produces（出力）: `alb_arn`、`alb_dns_name`、`certificate_validation_records`（name・type・value の一覧）、`url`
- Produces（bootstrap）: `paw.env` に `PAW_PUBLIC_URL=https://${domain_name}`、`PAW_AUTH=alb_oidc`、`PAW_ALB_ARN=${alb_arn}`、`PAW_ALLOWED_EMAIL=${allowed_email}`、`PAW_API_HOST=0.0.0.0`、`PAW_AWS_REGION=${region}`、`PAW_GITHUB_POLL_MS=900000`。`PAW_SIGNUP` と登録コードは書かない。Tailscale の導入・`tailscale up`・`tailscale serve`・SSM の `tailscale_auth_key` を消す
- EC2 は ALB より先に立つので、ARN は Terraform から user_data の変数で渡す（`aws_instance` が `aws_lb` に依存する）

- [ ] **Step 1: 検査を通す**

Run: `cd deploy/aws/terraform && terraform init -backend=false && terraform fmt -check && terraform validate`
Expected: すべて成功

- [ ] **Step 2: スクリプトを検査する**

Run: `bash -n deploy/aws/terraform/scripts/bootstrap.sh && grep -ci tailscale deploy/aws/terraform/scripts/bootstrap.sh`
Expected: 構文エラーなし、`tailscale` の出現が 0

- [ ] **Step 3: 差分を見積もる（任意・人の確認つき）**

`cloud-skuld` にログイン済みなら `terraform plan -var 'allowed_cidrs=["203.0.113.1/32"]'` で作られるリソースの一覧を出し、報告に貼る。`apply` はしない

- [ ] **Step 4: Commit**

```bash
git add deploy/aws/terraform/versions.tf deploy/aws/terraform/variables.tf deploy/aws/terraform/main.tf deploy/aws/terraform/outputs.tf deploy/aws/terraform/scripts/bootstrap.sh deploy/aws/terraform/terraform.tfvars.example deploy/aws/paw.env.example
git commit -m "feat(deploy): 社内 VPN の IP だけを通す ALB と Google ログインで公開し、Tailscale をやめる"
```

### Task 6: 手順書

**Files:**
- Modify: `deploy/aws/terraform/README.md`（正の手順）
- Modify: `deploy/aws/README.md`（Terraform の README への案内と、EC2 の中の通信制限の確認手順だけに縮める）
- Modify: `README.md`（常時運用の節の Tailscale の記述を置き換える）
- Modify: `docs/superpowers/specs/2026-11-02-issue-runner-design.md`（7.1・8.3・11 章の冒頭に「2026-11-06 の設計で置き換え」と 1 行ずつ）

**Interfaces:**
- `deploy/aws/terraform/README.md` に、設計書 7 章のユーザーの作業を順に書く:
  1. 会社の Google Cloud で OAuth クライアント（同意画面は内部、種類はウェブ アプリケーション、リダイレクト URI `https://agents-office.c.fnrr.biz/oauth2/idpresponse`）
  2. SSM への登録（GitHub App の ID と鍵、Claude のトークン、Google のクライアント ID と秘密）。登録コマンドの例
  3. `terraform.tfvars` に `allowed_cidrs` を書いて `apply`。`cloud-common` に書けないときの 2 段階手順
  4. 確認: VPN につないだ PC とスマホで開いて Google でログインできる、VPN を切ると届かない、別の Google アカウントでは「このアカウントでは使えません」、`curl` で EC2 の IP の 8787 番に直接届かない
  5. Terraform の状態ファイルに Google の秘密が入るので、状態ファイルを共有・コミットしない
- 費用の目安（EC2・ALB）と、止め方（`terraform destroy`）

- [ ] **Step 1: 記述の食い違いを探す**

Run: `grep -rn -i "tailscale\|funnel\|ts.net" README.md deploy/ docs/superpowers/specs/2026-11-06-aws-alb-access-design.md`
Expected: 「使わない」旨の説明以外に出てこない

- [ ] **Step 2: Commit**

```bash
git add deploy/aws/terraform/README.md deploy/aws/README.md README.md docs/superpowers/specs/2026-11-02-issue-runner-design.md
git commit -m "docs: 社内 VPN と Google ログインで開く常時運用の手順に書き換える"
```
