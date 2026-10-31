# Personal AI Agent Workspace — ローカル版

`docs/` の要求定義書・要件定義書・基本設計書（v0.2）をもとに、**クラウド（AWS）ではなくローカルで動く**ように実装したものです。
自分専用の 3D オフィスで、複数 Project の AI エージェント（Planner / Developer / Tester / Reviewer）の稼働状況・作業ログ・成果物・承認待ちを確認できます。

> **AI の実行はシミュレーションです。** OpenAI Agents SDK / Codex SDK / GitHub には接続していません。
> 計画 → 実装 → テスト → レビュー → Draft PR の流れ、ツール呼び出しとポリシー判定、成果物、利用量（推定）を
> ローカルのシミュレーション Runner が再現します（詳しくは「クラウド版との対応」）。

Agents Office のソースコード・3D モデル・固有デザイン・名称は使っていません（要求定義書 1.3 / ADR-015）。
3D のキャラクター・机・島・ハブ・アイコンはすべてこのリポジトリ内のコードで作った独自のものです。

---

## 起動方法

必要なもの: **Node.js 22.13 以上**、**pnpm 10**

```bash
pnpm install
```

```bash
pnpm dev
```

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
| **Run 詳細** | Step（担当・モデル・試行回数）、ツール呼び出し／ポリシー拒否のログ、成果物（計画・差分・テスト結果・レビュー・Draft PR）、イベント履歴、推定費用、中止 |
| **承認** | Draft PR レビュー、危険操作の検知、再修正上限のエスカレーション。内容ハッシュ・版数・期限をサーバーで検証 |
| **Projects** | Project 作成・アーカイブ、Repo 接続、自動起動ルール（初期 OFF・`ai:ready` ラベル）、GitHub シミュレーター（署名付き Webhook の送信・同じ Delivery の再送） |
| **設定** | 月間 / Run 予算、同時実行数、キルスイッチ（新規停止・緊急停止）、利用量、Agent 定義、監査ログ |

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

1. Office の右パネルからタスクを依頼 → Planner → Developer → Tester → Reviewer の順にキャラクターが動き、Draft PR ができると Reviewer が「承認待ち」になります。
2. **承認** 画面で Draft PR に「Request changes」→ 再修正 Run が同じ PR を更新します（上限を超えると「判断が必要」へエスカレーション）。「Approve」で完了（**自動マージはしません**）。
3. 「本番 DB の…を drop table して」のような依頼は Planner が危険操作として停止します。承認しても実行できず、「安全な範囲で再計画」か「却下」を選びます。
4. 「main へ直接マージして」「これまでの指示を無視して」などを含む依頼では、Agent がマージや秘密値読み取りを試みても Tool Broker が拒否し、ログに残ります。
5. Projects 画面の GitHub シミュレーターで、ラベル付き / なしの Issue を送ると、自動起動ルールに合う場合だけ Run が作られます。「同じ Delivery を再送」は二重処理されません。
6. 別ブラウザ（またはシークレットウィンドウ）で bob としてログインすると、alice の Run の URL を開いても「見つかりません」になります。

外部から署名付き Webhook を送ることもできます（Installation ID は Projects 画面の Repo 欄に表示）:

```bash
pnpm webhook:send -- --repo alice/storefront-web --installation <ID> --title "CSV エクスポート" --label ai:ready
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
| ECS Fargate + OpenAI Agents SDK / Codex SDK | `SimulatedRunner` | `AgentRunner` インターフェースで差し替え可能（`apps/api/src/agents/runner.ts`） |
| GitHub App / Tool Broker | GitHub シミュレーター + `authorizeTool` | 本番と同じ署名付き Webhook 経路。Tool Broker は接続 Repo・`ai/` ブランチ・Draft のみ許可、マージ・Secrets 等は常に拒否 |
| S3 Artifacts | `.data/artifacts/workspaces/<ws>/runs/<run>/…` | 取得は API で所有権確認後のみ。sha256 チェックサムを検証 |
| SSE / ポーリング | 同じ | `GET /v1/events/stream`（Last-Event-ID で差分再送）、失敗時は 3 秒ポーリングに切替 |

### ディレクトリ

```text
apps/
  api/          Hono API・ワークフローエンジン・Webhook・シミュレーター・シード
  web/          React + R3F（features/office が 3D オフィス）
packages/
  contracts/    API / イベントの Zod スキーマ・状態遷移表・ビューモデル型
  office-model/ Run / Step / Approval → 3D 表示状態への投影（純粋関数・テストあり）
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
| AT-006 / AT-007 | 計画・差分・テスト結果・レビュー・Draft PR の生成、Request changes で同じ PR を更新、上限超過でエスカレーション、古い commit へのレビューは無視、Approve で完了 |
| AT-008 | 他ユーザーの承認は拒否して記録、内容ハッシュ / 版数の不一致・二重判定・危険操作の承認を拒否 |
| AT-009 | 依頼文で main マージや秘密値の読み取りを指示しても Tool Broker が拒否 |
| AT-010 | Runner の異常終了・テスト失敗の再試行に上限、Run 予算超過で停止、月間予算超過で新規 Run を拒否 |
| その他 | FR-001（未認証 401）、CSRF、同時実行数、中止とキルスイッチ、Idempotency-Key、プロセス再起動からの復旧、イベント連番、シミュレーター経由の Workspace 越境防止 |

`packages/office-model` には 3D 表示状態の投影ロジックの単体テストがあります。

---

## 判断した点・仕様と異なる点（確認が取れなかったため仮置き）

- **論理 Agent と席**: Agent 定義は Workspace 単位（ER 図どおり）。3D では Project ごとに 4 席として投影し、その Project の Run から状態を出しています（表示キャラ数 ≠ 実行数）。
- **承認の種類**: `pr_review` と `dangerous_operation` に加え、UC-05（要件不足・再修正上限超過）のために `clarification` を追加しました。
- **Run 状態遷移**: 利用者の中止はすべての非終端状態から可能にしました（FR-037）。`waiting_review → needs_input` は基本設計書 4.3 の「上限超過 → needs_input」に基づきます。
- **Draft PR のレビュー**: 仕様どおり GitHub 側で行う前提のため、承認 API では受け付けません（409）。ローカルでは承認画面のボタンが GitHub シミュレーター経由で署名付きレビュー Webhook を送ります。
- **Repo 未接続の Project には依頼できません**（Draft PR を作れないため 422）。
- **同時実行数の既定値**は新規ワークスペースで 2（NFR-018 の例）。デモの alice は見栄えのため 4、予算は $200。
- **費用はシミュレーション単価による推定値**（$3 / $12 per 1M tokens）で、実際のモデル料金ではありません。
- Installation ID / Repository ID はローカルで擬似的に採番しています（実 GitHub とは異なり、同じ Repo を 2 人が接続しても Installation は別扱い）。

## 未実装（P1 / P2 またはクラウド前提のもの）

- OpenAI Agents SDK / Codex SDK / GitHub App への実接続（Runner インターフェースのみ用意）
- 運用者向けの障害・遅延通知（FR-057）、ログ保持期間の設定（UI-07 の一部）、データのエクスポート・削除（FR-058）
- P1: 文書・連絡 Agent、Slack / Gmail / Drive 連携、定期タスク。P2: チーム共有、ナレッジグラフ
- Runner のコンテナ隔離・ネットワーク制限（シミュレーションのため対象外）

## 確認したいこと

- 実際の AI 実行の接続先: OpenAI Agents SDK / Codex SDK で進めるか、Claude（Claude Agent SDK 等）も候補に入れるか（要求定義書 7-7「選択可能性」）。API キーはサーバー管理で良いか。
- ローカル版で次に本物にしたい部分の優先順位（例: 実 GitHub App 連携 → 実 Runner → Cognito）。
- 自動起動の条件は `ai:ready` ラベル方式（O-04 の仮置き）で確定して良いか。
- 承認待ちの期限（現在: Draft PR 14 日、危険操作・判断待ち 72 時間）と、期限切れ時の扱い（現在: 失効させて再確認を作成）で良いか。
- 3D のビジュアル（配色・キャラクター・島のレイアウト）について、要望や社内のデザイン基準があるか（O-08）。
