# Personal AI Agent Workspace — ローカル版

`docs/` の要求定義書・要件定義書・基本設計書（v0.2）をもとに、**クラウド（AWS）ではなくローカルで動く**ように実装したものです。
自分専用の 3D オフィスで、複数 Project の AI エージェント（Planner / Developer / Tester / Reviewer）の稼働状況・作業ログ・成果物・承認待ちを確認できます。

> **AI は Claude で動きます。** この PC の Claude Code に **claude.ai のサブスク（Pro / Max など）でログイン済み**なら、
> API キーなし・追加課金なしで、その利用枠を使って動きます。`ANTHROPIC_API_KEY`（Claude API・従量課金）でも動かせます。
> Project にローカルの git リポジトリを指定すると、Claude が Run ごとの専用ブランチで計画 → 実装 → テスト → レビューを進め、人が承認した後に PR にします（「Claude で実行する」）。
> どちらも無い場合や、ローカルリポジトリを指定していない Project はシミュレーションで動きます。
>
> **PC を閉じていても動かしたい場合**は、AWS の EC2 1 台で常時起動し、GitHub App で実際のリポジトリとつなげます（Issue に `agents-office` ラベル → AI が作業 → 人が承認 → PR）。画面は Tailscale のネットワーク内だけで開き（`tailscale serve`。インターネットには公開せず、GitHub の Webhook も受けず、サーバーが GitHub を見に行きます）、テストコマンドは Docker コンテナで動かします。手順は [deploy/aws/README.md](deploy/aws/README.md)（手作業）と [deploy/aws/terraform/README.md](deploy/aws/terraform/README.md)（Terraform）にあります。

Agents Office のソースコード・3D モデル・固有デザイン・名称は使っていません（要求定義書 1.3 / ADR-015）。
3D のキャラクター・机・島・ハブ・アイコンはすべてこのリポジトリ内のコードで作った独自のものです。

---

## 起動方法

必要なもの: **Node.js 22.13 以上**、**pnpm 10**

```bash
node -v
```

```bash
pnpm install
```

```bash
pnpm dev
```

Apple Silicon の Mac で `Cannot find native binding` や Homebrew の `Cannot install under Rosetta 2` が出る場合は、ターミナルが Rosetta 2（Intel 用の互換モード）で動いています。`uname -m` が `x86_64` なら、ターミナルの「情報を見る」で「Rosetta を使用して開く」を外して開き直してください（`arm64` になれば OK）。このリポジトリは Apple Silicon 用と Intel 用の両方のネイティブファイルを入れる設定なので、どちらのモードでも `pnpm dev` は動く想定です。

ブラウザで http://localhost:5173 を開き、ログイン画面の「ローカルデモ用アカウント」から **Alice** を選びます。

| アカウント | パスワード | 内容 |
|---|---|---|
| `alice` | `alice-local-demo` | 5 Project・20 Agent。起動直後から Run が動き、デモ用 GitHub イベントが自動で届きます |
| `bob` | `bob-local-demo` | 1 Project。alice のデータが見えないこと（Workspace 分離）の確認用 |

新規登録すると、空の個人ワークスペースが作られます（Project の作成から始めます）。

1 ポートで動かす場合（Web をビルドして API から配信）:

```bash
pnpm start
```

→ http://localhost:8787

データは `.data/`（PGlite のデータベース・成果物ファイル・ローカル秘密値）に保存されます。初期状態に戻すには:

```bash
pnpm db:reset
```

テスト:

```bash
pnpm test
```

型チェック:

```bash
pnpm typecheck
```

---

## 画面と操作

| 画面 | できること |
|---|---|
| **Office**（3D） | Project ごとの島・席・状態を俯瞰。島またはカードをクリックでその Project に寄る。キャラクターをクリックで担当 Run・ライブ作業ログ・成果物を表示。右パネルからタスクを依頼 |
| **Runs** | 全 Project の Run 一覧（検索・状態 / Project フィルター・ページング） |
| **Run 詳細** | Step（担当・モデル・試行回数）、ツール呼び出し／ポリシー拒否のログ、成果物（計画・差分・テスト結果・レビュー・PR）、イベント履歴、推定費用、中止 |
| **承認** | GitHub への書き込みの前の承認（publish）、PR レビュー、危険操作の検知、要件確認、再修正上限のエスカレーション、Claude の利用上限による一時停止からの再開。内容ハッシュ・版数・期限をサーバーで検証 |
| **Projects** | Project 作成・アーカイブ、Repo 接続、自動起動ルール（初期 OFF・`agents-office` ラベル。GitHub App で接続した Repo は `agents-office` 固定）、GitHub シミュレーター（署名付き Webhook の送信・同じ Delivery の再送） |
| **設定** | 月間 / Run 予算、同時実行数、キルスイッチ（新規停止・緊急停止）、利用量、Agent 定義、監査ログ |

### 見た目（デザイン案）

**採用案は B（Neon Control）** で、標準の見た目です。比較用に **設定 → 見た目** から A / C にも切り替えられます（選択はブラウザに保存）。

| 案 | 名前 | 特徴 |
|---|---|---|
| A | Night Studio | 夜のスタジオ。くすんだパステルの島、木目の机、人型のスタッフ、見出しはセリフ体。動画に最も近い落ち着いた雰囲気 |
| B | Neon Control | 管制室。半透明の島がプロジェクト色に発光し、ロボットが働く。角ばった HUD 風の文字 |
| C | Daylight Diorama | 昼の模型。明るい光と柔らかい影、粘土のような丸いキャラクター。ライトテーマ |

## Claude で実行する

Claude の動かし方は 2 通りあります。起動時に自動で選びます（`PAW_AGENT_RUNTIME=auto`）。

| 実行基盤 | 認証 | 費用 | 選ばれる条件（auto） |
|---|---|---|---|
| **Claude Code（サブスク）** | この PC の `claude` CLI のログイン（claude.ai アカウント） | **追加課金なし**。プランの利用枠（5 時間ごと・週ごとの上限。claude.ai のチャットと共有）を消費 | `claude auth status` が claude.ai / OAuth トークンでログイン済み、かつ Claude Code 2.1.248 以上 |
| Claude API | `ANTHROPIC_API_KEY` | トークン従量課金（サブスクとは別請求） | 上が使えず、API キーが設定されている |

サブスクと API キーの両方が使える場合は、**サブスクを優先**します（追加課金を避けるため）。API を使いたい場合は `PAW_AGENT_RUNTIME=claude` を指定してください。
選ばれた実行基盤と理由は **設定 → AI 実行基盤** に表示されます。

### A. サブスク（Claude Code）で動かす

1. Claude Code をインストールし、claude.ai アカウント（Pro / Max など）でログインします。

```bash
claude auth login
```

```bash
claude auth status
```

`"authMethod": "claude.ai"` と表示されれば準備完了です。

2. API を起動します（API キーは不要です。設定されていても Claude Code には渡しません）。

```bash
pnpm dev
```

3. **Projects** で、対象 Project の「Claude が作業するローカルリポジトリ」に git リポジトリの絶対パスを入れて保存します。テストコマンド（例: `pnpm install --frozen-lockfile && pnpm test`）は任意です。
4. Office の右パネルからその Project にタスクを依頼します。Run に **Claude Code（サブスク）** と表示されます。
5. AI レビューが通ると、承認画面に PR を作る承認（publish）が出ます。差分・PR 本文を確かめて承認すると PR（ローカルではブランチ）になります。リポジトリの `ai/run-…` ブランチを確認し、良ければ **人が** マージします。

**利用上限に達したとき:** Run は失敗にせず **一時停止（判断待ち）** になり、承認画面に「Claude の利用上限に達したため一時停止」が出ます（リセット予定時刻つき）。
上限がリセットされた後に **「続行（止まった工程から再開）」** を押すと、止まった工程からやり直します（計画からやり直したい場合は差し戻し、やめる場合は却下）。

Claude Code の起動方法（工程ごとに `claude -p` を 1 回呼びます。オプションはすべて公式ドキュメント記載のもの）:

| 設定 | 目的 |
|---|---|
| `--restricted` | シェル等のコマンド実行ツールと WebFetch を外し、ファイル操作を作業ディレクトリ（Run 専用の worktree）に限定。利用者・リポジトリの設定ファイル（hooks・権限・`.mcp.json`）を読まない |
| `--tools Read,Grep,Glob`（Developer のみ `+Edit,Write`） | 工程ごとに必要なツールだけ渡す。Planner / Reviewer は読み取りのみ |
| `--disallowedTools mcp__*` / `--strict-mcp-config` | MCP ツール（外部サービス連携）を使わせない |
| `--settings`（hooks 無効・自動メモリ無効・作業ディレクトリ外の読み取り禁止・拒否ルール） | `.env` などの秘密ファイルの読み取り、CI 設定・git フック・`.claude/`・`CLAUDE.md`・`.mcp.json` の変更を拒否 |
| `--json-schema` | 計画・レビュー結果を決まった JSON で受け取り、Zod で再検証 |
| `--no-session-persistence` / `--max-turns` | 会話履歴を残さない・ターン数の上限 |
| 子プロセスの環境変数 | `ANTHROPIC_*` などの秘密値を渡さない（API キーがあると Claude Code はサブスクより API 課金を優先するため） |
| 実行開始時の確認 | CLI が API キー（`apiKeySource`）で動こうとしたら止める（`PAW_CLAUDE_CODE_ALLOW_API_BILLING=1` で許可） |
| 実行後の検査 | 変更されたファイルを `git status` で調べ、禁止パスへの変更があればその試行の変更をすべて破棄して失敗にする（CLI 側の設定に頼らない最終確認） |

**確認できていること・いないこと:** この開発環境では本物の `claude` を呼べない（利用者のサブスクで動かせない）ため、公式ドキュメントの出力形式（`stream-json` の init / assistant / rate_limit_event / result）を再現した**偽の CLI でのテストまで**です。
お手元の Pro アカウントでの実際の動作（特に `--restricted` でサブスクのログインが使えるか、利用上限時に CLI が実際に出す内容）は未確認です。
もし `--restricted` で問題が出る場合は `PAW_CLAUDE_CODE_RESTRICTED=0` で無効化できます（その場合も `--setting-sources user` でリポジトリ側の設定は読みません）。ただしサーバーモード（`PAW_PUBLIC_URL` あり）では使えません（起動を拒みます）。
利用者の Mac では、`claude auth login` でログインし直し、`PAW_CLAUDE_CODE_RESTRICTED=0` を付けた状態で、計画 → 実装 → レビュー → GitHub への Draft PR 作成まで動作しました（制限モードだけが原因だったかは未切り分け）。
Windows は未対応です（macOS / Linux を想定）。

### B. API キー（Claude API）で動かす

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

```bash
PAW_AGENT_RUNTIME=claude pnpm dev
```

（サブスクでログインした Claude Code が無い環境では `PAW_AGENT_RUNTIME` の指定は不要です。）

### 役割ごとの Claude の使い方

| 役割 | Claude Code（サブスク） | Claude API |
|---|---|---|
| Planner | `claude -p --json-schema`（読み取りのみ）で計画（進め方・変更予定ファイル・受入条件・リスク・要確認事項）を返す | Messages API の構造化出力 |
| Developer | `claude -p`（Read / Grep / Glob / Edit / Write のみ・シェルなし）で worktree のファイルを変更 | Messages API のツール呼び出しループ（`list_files` / `read_file` / `search_code` / `write_file` / `edit_file`。1 回ずつ Tool Broker が判定） |
| Tester | Claude は使わず、Project に設定したテストコマンドを worktree で実行（シェルを介さない・秘密値の環境変数は渡さない） | 同左 |
| Reviewer | `claude -p --json-schema`（読み取りのみ）で受入条件との照合・blocker・nit を返す。blocker があれば Developer に差し戻す | Messages API の構造化出力 |

安全のための制限（共通）:
- 作業は Run ごとの git worktree（`.data/worktrees/<run>`、ブランチ `ai/run-…`）の中だけ。リポジトリ外・`.git`・`node_modules`・秘密情報らしいファイル（`.env`, `*.pem` など）・CI 設定や git フック・AI エージェント設定（`.claude/`・`CLAUDE.md`・`.mcp.json`）は変更できません。Developer はシェルを実行できません。
- 依頼本文・Issue・リポジトリの内容は非信頼入力として区切って渡し、その中の指示ではツールや権限は変わりません。
- テストコマンドはあなたのマシンでそのまま実行されます（コンテナ隔離はローカル版では未実装）。信頼できるリポジトリにだけ設定してください。Developer が書いたコードやパッケージのスクリプトもテスト時に実行されます。
- Run・月の予算、同時実行数、キルスイッチは Claude 実行にも適用されます。Claude API の費用は API が返したトークン数（実測）× 公開単価で記録します。サブスク枠での実行は API の請求が無いため費用 $0 として記録し、トークン数と「API 換算の目安」だけをログに残します（予算では止まりません。プランの利用上限で一時停止します）。
- Claude が応答を拒否した場合（refusal）は再試行せず失敗にします。
- 変更の無かった Run のブランチは片付け、コミットのあるブランチはレビューのため残します。

環境変数:

| 変数 | 既定値 | 内容 |
|---|---|---|
| `PAW_AGENT_RUNTIME` | `auto` | `auto`（サブスクの Claude Code → API キー → シミュレーションの順）/ `claude-code` / `claude` / `simulated` |
| `PAW_CLAUDE_CODE_BIN` | `claude` | Claude Code CLI のパス |
| `PAW_CLAUDE_CODE_MODEL` | （CLI の既定） | `opus` / `sonnet` などのエイリアスかモデル名。プランで使えるモデルは CLI 側が決めます |
| `PAW_CLAUDE_CODE_EFFORT` | （CLI の既定） | `low` / `medium` / `high` / `xhigh` / `max` |
| `PAW_CLAUDE_CODE_MAX_TURNS` | `60` | Developer 1 回あたりのターン上限（Planner / Reviewer は `PAW_CLAUDE_CODE_PLAN_MAX_TURNS` / `PAW_CLAUDE_CODE_REVIEW_MAX_TURNS`、既定 30） |
| `PAW_CLAUDE_CODE_RESTRICTED` | `1` | `0` で `--restricted` を使わない |
| `PAW_CLAUDE_CODE_ALLOW_API_BILLING` | `0` | `1` で Claude Code が API キーで動くことを許可 |
| `PAW_CLAUDE_MODEL` | `claude-opus-5-5` | Claude API で使うモデル |
| `PAW_CLAUDE_EFFORT` | `high` | Claude API の effort |
| `PAW_CLAUDE_STEP_TIMEOUT_MS` | `1800000` | Claude で実行する工程 1 つのタイムアウト（30 分） |
| `PAW_TEST_TIMEOUT_MS` | `600000` | テストコマンドのタイムアウト |

### GitHub App で実際のリポジトリとつなぐ（サーバー運用）

`PAW_GITHUB_APP_ID` と秘密鍵を設定すると、GitHub シミュレーターの代わりに実際の GitHub とつながります。設定の詳細は [deploy/aws/README.md](deploy/aws/README.md) を参照してください。

- **Repo の接続:** GitHub API でインストール済みであることを確認し、実際の Repository ID・既定ブランチを使います。
- **作業コピー:** サーバー上の管理クローン（`.data/repos/<id>`）から Run ごとに作ります。起点は `origin/<既定ブランチ>` です。
- **成果物:** 人が publish 承認をした後に、`ai/run-…` ブランチを GitHub に push し、通常の PR（Issue の Run は本文 1 行目が `Closes #<番号>`）を作ります。Request changes のときは、もう一度承認を経て同じ PR に追加の push をします。
- **PR の扱い:** Approve かマージで Run は完了、マージせずに閉じると中止になります。
- **受け付ける操作:** Issue からの起動は、画面の「AI に任せる」か、自分（`PAW_GITHUB_LOGIN`）が付けた `agents-office` ラベルだけです。ラベル・PR レビューの送り主は `PAW_GITHUB_ALLOWED_USERS` に入れた GitHub ユーザーに限ります（未設定なら `PAW_GITHUB_LOGIN` だけ）。
- **トークン:** GitHub のトークンは Installation token（短期）をメモリにだけ保持し、git には askpass で渡します。Claude Code には渡しません。

| 変数 | 内容 |
|---|---|
| `PAW_GITHUB_APP_ID` / `PAW_GITHUB_APP_PRIVATE_KEY_FILE` | GitHub App の ID と秘密鍵（.pem）のパス |
| `PAW_GITHUB_LOGIN` | 「自分担当」の Issue を判定する GitHub ログイン名（未設定なら `PAW_GITHUB_ALLOWED_USERS` の先頭） |
| `PAW_GITHUB_POLL_MS` | GitHub を見に行く間隔（ミリ秒。既定 60000、最小 10000） |
| `PAW_GITHUB_WEBHOOK` | `1` で署名付き Webhook の受け口を開く（開発用）。このときだけ `PAW_GITHUB_WEBHOOK_SECRET`（16 文字以上）が要る。本番では設定しない |
| `PAW_TEST_SANDBOX` / `PAW_TEST_IMAGE` / `PAW_TEST_NETWORK` | Tester の実行方法（`docker` / `host`）、イメージ、Docker ネットワーク。サーバーモードは `docker` 必須 |
| `PAW_GITHUB_ALLOWED_USERS` | ラベル・PR レビューを受け付ける GitHub ユーザー（カンマ区切り。未設定なら `PAW_GITHUB_LOGIN` だけ） |
| `PAW_PUBLIC_URL` | 公開 URL（HTTPS なら Cookie に Secure を付け、Origin を許可） |
| `PAW_SIGNUP` | `open`（既定）/ `first_user`（最初の 1 人だけ）/ `closed` |
| `PAW_SIGNUP_CODE` | 設定すると、新規登録にこのコードが必要（公開 URL で他人に先に登録されないように） |
| `PAW_SERVE_WEB` | `1` で API からビルド済みの画面も配信 |

#### GitHub App の作り方（agents-office 専用）

他の App（meeting-note など）は使い回さず、agents-office 専用に作ります（秘密鍵が AI の動くサーバーに置かれるため、漏れたときの範囲を絞ります）。

- **権限**: Contents・Pull requests・Issues は Read and write、Metadata は Read-only
- **Webhook**: 無効（Active のチェックを外す）。イベントの購読も不要
- **インストール**: **Only select repositories** で、AI に任せるリポジトリだけを選ぶ。組織（例 `fenrir-inc`）では**組織のオーナーの承認**が要る。案件が増えたらインストール先にリポジトリを足し、画面の Projects で Repo を接続する

#### 常時運用の初回確認

[deploy/aws/README.md](deploy/aws/README.md) の手順で起動したら、次を順に確かめます。

1. サインインする（最初のユーザー `first_user` として、登録コードで登録）
2. Projects で Repo を接続する（App を入れたリポジトリだけ選べる）
3. 案件の Issue 一覧が出る（最大 60 秒）
4. 影響の小さい Issue を 1 件「AI に任せる」
5. 「GitHub に出す」の承認カードで差分を確かめて承認する
6. PR ができる（本文は `Closes #<番号>` で始まる）

#### Docker の権限（サーバー運用）

Tester は Docker コンテナで動き、`paw` ユーザーを `docker` グループに入れます。**このグループはホストの root と同等の権限です。** それでも通常の Docker にしたのは、ホスト側の iptables（raw テーブル）でコンテナからホスト・内部ネットワーク・メタデータ・tailnet への通信を落とすためです（rootless Docker ではこの制限が効きません）。AI は `--restricted` で動かし、`docker` を呼ぶのはアプリだけにしています。詳細は [deploy/aws/README.md](deploy/aws/README.md) の手順 4b。

### ブラウザだけで動くデモ

API を起動せずに見た目と動きを確認できるデモ版もあります（AI 実行・GitHub・データはすべてブラウザ内のシミュレーション）。

```bash
pnpm build:demo
```

```bash
pnpm --filter @paw/web preview:demo
```

3D 表示の操作: ドラッグでパン、ホイールでズーム、右下のボタン（＋／−／視点初期化／低負荷表示／2D 切替）。
キーボード: `+` `-` ズーム、`0` 視点初期化、`Esc` 選択解除。WebGL が使えない環境では自動で 2D 表示になります。

キャラクターの状態は、色だけでなくアイコン・文字・形でも区別しています。

| 状態 | 3D 上の表現 |
|---|---|
| 待機 | 首を左右に振る・画面はスクリーンセーバー |
| 作業中 | タイピング・画面にコードが流れる・コード片が立ち上る |
| レビュー中 | ルーペが頭の周りを回る・差分画面 |
| 承認待ち | 手を挙げる・頭上に黄色の菱形・足元にパルス |
| 完了 | 両手を挙げる・緑のチェック |
| 失敗 | うなだれる・赤い × とパルス |

### 試してみる流れ

1. Office の右パネルからタスクを依頼 → Planner → Developer → Tester → Reviewer の順にキャラクターが動き、PR ができると Reviewer が「承認待ち」になります。
2. **承認** 画面で PR に「Request changes」→ 再修正 Run が同じ PR を更新します（上限を超えると「判断が必要」へエスカレーション）。「Approve」で完了（**自動マージはしません**）。
3. 「本番 DB の…を drop table して」のような依頼は Planner が危険操作として停止します。承認しても実行できず、「安全な範囲で再計画」か「却下」を選びます。
4. 「main へ直接マージして」「これまでの指示を無視して」などを含む依頼では、Agent がマージや秘密値読み取りを試みても Tool Broker が拒否し、ログに残ります。
5. Projects 画面の GitHub シミュレーターで、ラベル付き / なしの Issue を送ると、自動起動ルールに合う場合だけ Run が作られます。「同じ Delivery を再送」は二重処理されません。
6. 別ブラウザ（またはシークレットウィンドウ）で bob としてログインすると、alice の Run の URL を開いても「見つかりません」になります。

外部から署名付き Webhook を送ることもできます（Installation ID は Projects 画面の Repo 欄に表示）:

```bash
pnpm webhook:send -- --repo alice/storefront-web --installation <ID> --title "CSV エクスポート" --label agents-office
```

`--forge` を付けると不正な署名で送信し、401 で拒否されることを確認できます。

依頼本文に次のマーカーを入れると挙動を固定できます（テスト・デモ用）:

| マーカー | 挙動 |
|---|---|
| `[sim:crash]` | Developer の Runner が毎回異常終了 → 上限付き再試行の後に失敗 |
| `[sim:test-fail]` | テストが毎回失敗 → 自動修正 2 回の後に失敗 |
| `[sim:expensive]` | トークンを大量消費 → Run 予算超過で停止 |

---

## クラウド版との対応（ローカルでの置き換え）

| 基本設計書（クラウド） | ローカル版 | 備考 |
|---|---|---|
| React + Vite + TypeScript / Three.js + React Three Fiber + Drei（OrthographicCamera） | 同じ | `apps/web` |
| Hono + Node.js | 同じ | `apps/api` |
| Amazon Cognito | ローカル認証（scrypt + HttpOnly / SameSite=Strict Cookie の JWT） | 認証と Workspace 所有権の認可は分離 |
| RDS for PostgreSQL + Drizzle | **PGlite**（WASM 版 PostgreSQL）+ Drizzle | 同じ SQL 方言。マイグレーションは `apps/api/drizzle` |
| Step Functions Standard | `WorkflowEngine`（プロセス内・DB 永続） | 遷移表どおりの状態遷移、楽観ロック、再試行・タイムアウト・予算・同時実行数、再起動時の復旧 |
| API Gateway + Lambda（Webhook 検証） | `POST /integrations/github/webhook` | raw body の HMAC-SHA256 を定数時間比較、サイズ・ヘッダー検証 |
| SQS + DLQ / Lambda Dispatcher | `webhook_deliveries` テーブル（永続キュー）+ `Dispatcher` | `provider + delivery_id` の一意制約で冪等化。5 回失敗で dead_letter |
| ECS Fargate + OpenAI Agents SDK / Codex SDK | `ClaudeRunner` + Run ごとの git worktree。モデル呼び出しは `ClaudeCodeBackend`（この PC の Claude Code CLI・サブスク）か `ClaudeApiBackend`（Claude API）。どちらも使えない・ローカルリポジトリ未指定時は `SimulatedRunner` | `apps/api/src/agents/claude/`。コンテナ隔離は未実装 |
| GitHub App / Tool Broker | GitHub シミュレーター + `authorizeTool` | 本番と同じ署名付き Webhook 経路。Tool Broker は接続 Repo の `ai/` ブランチへの push と PR の作成・更新（人の publish 承認の後）のみ許可、マージ・Secrets 等は常に拒否 |
| S3 Artifacts | `.data/artifacts/workspaces/<ws>/runs/<run>/…` | 取得は API で所有権確認後のみ。sha256 チェックサムを検証 |
| SSE / ポーリング | 同じ | `GET /v1/events/stream`（Last-Event-ID で差分再送）、失敗時は 3 秒ポーリングに切替 |

### ディレクトリ

```text
apps/
  api/          Hono API・ワークフローエンジン・Webhook・シミュレーター・シード
  web/          React + R3F（features/office が 3D オフィス、src/demo がブラウザ内デモ）
packages/
  contracts/    API / イベントの Zod スキーマ・状態遷移表・ビューモデル型
  office-model/ Run / Step / Approval → 3D 表示状態への投影（純粋関数・テストあり）
  sim-content/  シミュレーションの成果物（計画・差分・テスト結果など）の生成（API とデモで共有）
docs/           要求定義書・要件定義書・基本設計書
```

---

## テスト（`pnpm test`）

`apps/api/src/acceptance.test.ts`（PGlite をメモリで起動して API を直接呼び出す）:

| 要件定義書のテスト | 内容 |
|---|---|
| AT-001 | bob から alice の Run / 成果物 / ログ / Project を取得・更新できない（404）、一覧・SSE にも混入しない |
| AT-004 | 正しい署名の Webhook だけ受理、偽造・改ざんは 401、同じ Delivery の再送は二重実行しない、同一 Issue の二重起動を防止 |
| AT-005 | 自動起動 OFF・ラベル不一致では Run を作らず、理由だけ記録 |
| AT-006 / AT-007 | 計画・差分・テスト結果・レビュー・PR の生成、Request changes で同じ PR を更新、上限超過でエスカレーション、古い commit へのレビューは無視、Approve で完了 |
| AT-008 | 他ユーザーの承認は拒否して記録、内容ハッシュ / 版数の不一致・二重判定・危険操作の承認を拒否 |
| AT-009 | 依頼文で main マージや秘密値の読み取りを指示しても Tool Broker が拒否 |
| AT-010 | Runner の異常終了・テスト失敗の再試行に上限、Run 予算超過で停止、月間予算超過で新規 Run を拒否 |
| その他 | FR-001（未認証 401）、CSRF、同時実行数、中止とキルスイッチ、Idempotency-Key、プロセス再起動からの復旧、イベント連番、シミュレーター経由の Workspace 越境防止 |

`apps/api/src/claude-code.test.ts`（Claude Code・サブスク実行基盤）: 公式ドキュメントの `stream-json` 形式を再現した偽の `claude` CLI を使い、一時ディレクトリの実 git リポジトリで検証します。
起動オプション（`--restricted`・ツール制限・hooks 無効・拒否ルール・JSON スキーマ）、API キー等を子プロセスに渡さないこと、`ai/` ブランチへのコミット、CI 設定・`.claude/` への変更の破棄、利用上限での一時停止と「続行」で同じ工程から再開すること、未ログイン・CLI 不在・API キー課金の検出、異常終了の上限付き再試行、中止時に CLI プロセスを止めること、起動時の自動判定（サブスク優先）を確認しています。**本物の Claude Code・サブスクでの動作は未確認です。**

`apps/api/src/github-app.test.ts`（GitHub App 連携）: GitHub REST API のモック（App の JWT を公開鍵で検証）と git の bare リポジトリを使い、実際の GitHub と同じ形式の署名付き Webhook から検証します。
インストール済みリポジトリだけ接続できること、許可していないユーザーの Issue・レビューを無視すること、`ai/` ブランチの push と PR の作成、Request changes で同じ PR を更新すること、マージで完了・マージせずに閉じると中止、トークンを git の設定や Claude Code に渡さないこと、偽造 Webhook の拒否を確認しています。**本物の GitHub・AWS での動作は未確認です。**

`apps/api/src/claude.test.ts`（Claude API 実行基盤）: Claude API の代わりに台本どおり応答する偽クライアントを注入し、一時ディレクトリの実 git リポジトリで検証します。
ローカルリポジトリの検証、worktree 外・秘密ファイル・CI 設定へのアクセス拒否、`ai/` ブランチへのコミット、構造化出力・フォールバック設定、実測トークンによる費用、refusal と SDK エラーを再試行しないこと、要件確認からの再計画、変更の無い Run のブランチ片付けを確認しています。**実際の Claude API への接続は、この開発環境に API キーが無いため未確認です。**

`packages/office-model` には 3D 表示状態の投影ロジックの単体テストがあります。

---

## 判断した点・仕様と異なる点（確認が取れなかったため仮置き）

- **論理 Agent と席**: Agent 定義は Workspace 単位（ER 図どおり）。3D では Project ごとに 4 席として投影し、その Project の Run から状態を出しています（表示キャラ数 ≠ 実行数）。
- **承認の種類**: `pr_review` と `dangerous_operation` に加え、UC-05（要件不足・再修正上限超過）のために `clarification` を追加しました。
- **Run 状態遷移**: 利用者の中止はすべての非終端状態から可能にしました（FR-037）。`waiting_review → needs_input` は基本設計書 4.3 の「上限超過 → needs_input」に基づきます。サブスクの利用上限で工程を一時停止・再開するため、`validating → needs_input` と `needs_input → running / validating` を追加しました（ご要望による）。
- **PR のレビュー**: 仕様どおり GitHub 側で行う前提のため、承認 API では受け付けません（409）。ローカルでは承認画面のボタンが GitHub シミュレーター経由で署名付きレビュー Webhook を送ります。
- **Repo 未接続の Project には依頼できません**（PR を作れないため 422）。
- **同時実行数の既定値**は新規ワークスペースで 2（NFR-018 の例）。デモの alice は見栄えのため 4、予算は $200。
- **AI 実行基盤は Claude を採用**（仕様書の OpenAI Agents SDK / Codex SDK の代わり）。サブスクで動かすため、利用者がログイン済みの Claude Code CLI（`claude -p`）を呼ぶ方式を追加し、auto ではこちらを優先します。Claude Agent SDK のドキュメントには「承認なしに第三者の製品で claude.ai ログインを提供してはならない」とあるため、**この方式は自分の PC で自分のログインを使う個人利用に限る前提**です（他の人に提供するサービスやクラウド版では API キー等を使います）。
- Claude API で動かす場合の Developer は、Claude Agent SDK ではなく Messages API のツール呼び出しで実装しました。ファイル操作を 1 回ずつ Tool Broker で判定できるためです。Claude Code で動かす場合はファイル操作を CLI が行うため、工程開始時に Tool Broker でツールの許可を判定し、CLI の権限設定で制限したうえで、実行後に変更パスを検査します。
- 以前の版では工程のタイムアウトが一律 2 分で、Claude の Developer 工程がほぼ確実にタイムアウトする不具合がありました。Claude で実行する Run は 30 分（`PAW_CLAUDE_STEP_TIMEOUT_MS`）に分けました。
- シミュレーション Run の費用はシミュレーション単価（$3 / $12 per 1M tokens）による推定値です。Claude Run は実測トークン × 公開単価です。
- Installation ID / Repository ID はローカルで擬似的に採番しています（実 GitHub とは異なり、同じ Repo を 2 人が接続しても Installation は別扱い）。

## 未実装（P1 / P2 またはクラウド前提のもの）

- GitHub 側への作業状況コメント / Check 表示（FR-027・P1）
- Runner のコンテナ隔離（テストコマンドはローカルで直接実行）
- 運用者向けの障害・遅延通知（FR-057）、ログ保持期間の設定（UI-07 の一部）、データのエクスポート・削除（FR-058）
- P1: 文書・連絡 Agent、Slack / Gmail / Drive 連携、定期タスク。P2: チーム共有、ナレッジグラフ

## 確認したいこと

- Claude Code（サブスク）での実行は、偽の CLI でのテストまでしか確認できていません。お手元で `pnpm dev` → 小さなリポジトリで 1 件試していただけますか。設定 → AI 実行基盤に「Claude Code（サブスク）」と出るか、Run が PR まで進むかを確認したいです。うまくいかない場合は、Run 詳細のログ（エラーコード）を教えてください。
- Pro プランの Claude Code で使えるモデル（Opus が使えるか）は公式ページで確認できなかったため、既定では CLI に任せています。モデルを固定したい場合は `PAW_CLAUDE_CODE_MODEL` で指定できます。
- ローカル版で次に本物にしたい部分の優先順位（例: 実 GitHub App 連携 → 実 Runner → Cognito）。
- 承認待ちの期限（現在: PR レビュー 14 日・publish 72 時間、危険操作・判断待ち 72 時間）と、期限切れ時の扱い（現在: 失効させて再確認を作成）で良いか。
- 3D のビジュアル（配色・キャラクター・島のレイアウト）について、要望や社内のデザイン基準があるか（O-08）。
