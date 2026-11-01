# AWS（EC2 1 台）＋ Tailscale Funnel で常時動かす手順

PC を閉じていても、GitHub の Issue にラベルを付けると AI が作業し、Draft PR を作る構成です。利用者は自分 1 人、AI は Claude のサブスク（Pro など）を使います。
ドメインは不要です。HTTPS の URL（`https://<名前>.<tailnet名>.ts.net`）は Tailscale Funnel から無料でもらいます。

```text
GitHub ──Webhook(HTTPS)──▶ Tailscale Funnel ──▶ API :8787（127.0.0.1 のみ）──▶ Claude Code CLI（サブスクのトークン）
   ▲                                               │
   └────────── push（ai/ ブランチ）・Draft PR ◀──────┘（GitHub App の短期トークン）
ブラウザ ──HTTPS──▶ Tailscale Funnel ──▶ 画面（ログイン必須・新規登録は最初の 1 人だけ）
```

EC2 は外からの接続を受け付けません（受信ポートは SSH だけ、それも自分の IP に限定）。Funnel は EC2 から Tailscale へ外向きにつなぎ、届いた HTTPS をアプリに渡します。

> **確認状況**
> - アプリ: 利用者の Mac で、本物の GitHub とサブスクの Claude Code を使い「依頼 → 計画 → 実装 → AI レビュー → GitHub に Draft PR」まで動作を確認済み（`PAW_CLAUDE_CODE_RESTRICTED=0`）。GitHub からの Webhook 受信（Issue からの自動起動・レビューでの修正・マージでの完了）は、モックを使ったテストまでで、本物では未確認です。
> - Tailscale: コマンドは Tailscale の CLI のソースコード（ヘルプ文）で確認した範囲です。公式ドキュメント（tailscale.com）には作成時に接続できず、インストール手順や Funnel の有効化の画面は未確認です。表示が手順と違う場合は、画面の案内を優先してください。

## 必要なもの

| もの | 理由 |
|---|---|
| AWS アカウント | EC2 1 台 |
| Tailscale アカウント（無料の個人プランで可） | HTTPS の公開 URL（Funnel）を作る。GitHub アカウントでサインアップできる |
| GitHub App | ローカルで試した App を使い回せます（手順 5） |
| Claude のサブスク（Pro 以上） | `claude setup-token` でサーバー用のトークンを作る |

---

## 1. EC2 を作る（AWS コンソール）

AWS コンソール右上のリージョンを **東京（ap-northeast-1）** にして、**EC2 → インスタンスを起動** を開きます。

| 項目 | 設定 |
|---|---|
| 名前 | `paw` |
| AMI | **Ubuntu Server 24.04 LTS**、アーキテクチャ **64 ビット (Arm)** |
| インスタンスタイプ | **t4g.medium**（メモリ 4GB。Claude Code の公式要件が 4GB 以上） |
| キーペア | **新しいキーペアを作成**（名前 `paw`、RSA、.pem）。ダウンロードされた `paw.pem` を保存 |
| ネットワーク設定 | **SSH トラフィックを許可: 自分の IP**。HTTP・HTTPS のチェックは**入れない** |
| ストレージ | **30 GiB**（gp3） |

**インスタンスを起動** を押し、インスタンス一覧で状態が「実行中」になったら **パブリック IPv4 アドレス** を控えます。
料金はインスタンスタイプとストレージで決まります。AWS の料金ページで確認してください。

## 2. SSH で入る（手元の Mac）

```bash
mv ~/Downloads/paw.pem ~/.ssh/paw.pem && chmod 400 ~/.ssh/paw.pem
```

`<パブリック IP>` を置き換えて:

```bash
ssh -i ~/.ssh/paw.pem ubuntu@<パブリック IP>
```

以降の手順 3〜4 はサーバー上で実行します。

## 3. サーバーの準備（サーバー上）

```bash
sudo apt update && sudo apt install -y git curl ca-certificates
```

Node.js 22（NodeSource の公式手順）:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
```

```bash
sudo -E bash nodesource_setup.sh
```

```bash
sudo apt install -y nodejs
```

pnpm（リポジトリの `packageManager` に書かれた版を corepack が使う）:

```bash
sudo corepack enable
```

アプリを動かす専用ユーザーと、データ・設定の置き場所:

```bash
sudo useradd -m -s /bin/bash paw
```

```bash
sudo mkdir -p /var/lib/paw /etc/paw && sudo chown paw:paw /var/lib/paw && sudo chmod 700 /var/lib/paw
```

アプリと Claude Code を `paw` ユーザーで入れます:

```bash
sudo -iu paw
```

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

```bash
git clone https://github.com/Toshipy/agents-office.git && cd agents-office
```

```bash
pnpm install --frozen-lockfile
```

初回は pnpm のダウンロードの確認が出ることがあります。その場合は `Y` で進めてください。

```bash
pnpm --filter @paw/web build
```

```bash
exit
```

## 4. Tailscale Funnel で HTTPS の URL を作る（サーバー上）

Tailscale を入れます（Tailscale が案内している Linux 用のインストールスクリプト）:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

サーバーを自分の Tailscale につなぎます。表示される URL をブラウザで開いてログインしてください。`--hostname=paw` で URL の先頭が `paw` になります:

```bash
sudo tailscale up --hostname=paw
```

アプリ（127.0.0.1:8787）をインターネットに公開します（`--bg` でバックグラウンドに常駐し、再起動後も設定が残ります）:

```bash
sudo tailscale funnel --bg 8787
```

初めて使うときは、Funnel や HTTPS 証明書をこの tailnet で有効にするよう求められることがあります。表示されたリンクを開いて有効にし、もう一度同じコマンドを実行してください。

公開 URL を確認します（`https://paw.<tailnet名>.ts.net` のような URL が表示されます。以降 `<公開 URL>` と書きます）:

```bash
tailscale funnel status
```

アプリはまだ起動していないので、この時点で URL を開くとエラーになるのは正常です。

**鍵の有効期限を切る:** Tailscale の端末の鍵には有効期限があり（既定は 180 日だったはず。未確認）、切れるとサーバーが Tailscale から外れて Funnel も止まります。Tailscale の管理画面（https://login.tailscale.com/admin/machines）で `paw` の「…」メニューから **Disable key expiry** を選んでおいてください。

## 5. GitHub App の設定を変える（ブラウザ）

ローカルで作った App を使い回します。https://github.com/settings/apps で App の **Edit** を開きます。

1. **General → Webhook**
   - **Active** にチェック
   - Webhook URL: `<公開 URL>/integrations/github/webhook`
   - Webhook secret: 手元の Mac で `openssl rand -hex 32` を実行して作った値（手順 7 の `PAW_GITHUB_WEBHOOK_SECRET` にも同じ値を入れる）
   - **Save changes**
2. **Permissions & events → Subscribe to events**: **Issues** / **Pull request** / **Pull request review** にチェックして **Save changes**
3. **General → Private keys → Generate a private key**: サーバー用に**新しい鍵**を作ります（手元の Mac の鍵と分けておくと、片方だけ無効にできます）
4. App ID は変わりません（**General → About** の App ID）

## 6. 秘密鍵とサブスクのトークンを用意する（手元の Mac）

ダウンロードされた新しい秘密鍵をサーバーへ送ります（ファイル名は実際のものに置き換える）:

```bash
scp -i ~/.ssh/paw.pem ~/Downloads/*.private-key.pem ubuntu@<パブリック IP>:/tmp/github-app.pem
```

サーバー用のサブスクのトークンを作ります。ブラウザで承認すると、1 年間有効なトークンが表示されます（どこにも保存されないので、次の手順で貼り付けます）:

```bash
claude setup-token
```

このトークンと秘密鍵は、他の人に見せたり Git にコミットしたりしないでください。

## 7. 設定ファイル（サーバー上）

秘密鍵を置きます:

```bash
sudo mv /tmp/github-app.pem /etc/paw/github-app.pem && sudo chown root:paw /etc/paw/github-app.pem && sudo chmod 640 /etc/paw/github-app.pem
```

設定ファイルを作ります:

```bash
sudo cp /home/paw/agents-office/deploy/aws/paw.env.example /etc/paw/paw.env && sudo chown root:paw /etc/paw/paw.env && sudo chmod 640 /etc/paw/paw.env
```

セッション用の鍵を作り、表示された値を控えます:

```bash
openssl rand -hex 32
```

```bash
sudo nano /etc/paw/paw.env
```

| 変数 | 入れる値 |
|---|---|
| `PAW_PUBLIC_URL` | `<公開 URL>`（`https://paw.….ts.net`。末尾の `/` は付けない） |
| `PAW_SESSION_SECRET` | 上で作った値 |
| `PAW_SIGNUP_CODE` | `openssl rand -hex 16` で作った値（手順 10 の新規登録で入力する） |
| `CLAUDE_CODE_OAUTH_TOKEN` | 手順 6 のトークン |
| `PAW_GITHUB_APP_ID` | App ID |
| `PAW_GITHUB_WEBHOOK_SECRET` | 手順 5 で App に設定した Webhook secret と同じ値 |
| `PAW_GITHUB_ALLOWED_USERS` | `Toshipy`（この人の Issue・レビューだけを受け付ける） |

nano は Ctrl+O → Enter で保存、Ctrl+X で終了です。

## 8. Claude Code の動作確認（サーバー上）

サーバー用のトークンで Claude Code が動くかを確認します（`ok` と返れば OK。利用枠はほとんど使いません）:

```bash
sudo -H -u paw bash -c 'set -a; . /etc/paw/paw.env; set +a; cd /tmp && ~/.local/bin/claude -p "ok とだけ返して"'
```

続けて、制限モード（`--restricted`）でも動くかを確認します:

```bash
sudo -H -u paw bash -c 'set -a; . /etc/paw/paw.env; set +a; cd /tmp && ~/.local/bin/claude -p "ok とだけ返して" --restricted'
```

- 認証エラーになる → `/etc/paw/paw.env` の `PAW_CLAUDE_CODE_RESTRICTED=0` のまま（手元の Mac ではこの設定で動作確認済み）
- `ok` と返る → `1` にすると、Claude Code が利用者・リポジトリの設定を読まない、より制限の強い起動になります

## 9. 起動する（サーバー上）

```bash
sudo cp /home/paw/agents-office/deploy/aws/paw.service /etc/systemd/system/paw.service
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now paw
```

起動の確認（`agent runtime` に `claude_code`、`github app` に App ID、最後に `api listening` が出ていれば OK）:

```bash
sudo journalctl -u paw -n 50 --no-pager
```

## 10. 使い始める（ブラウザ）

1. 起動したらすぐに `<公開 URL>` を開き、**新規登録**で自分のアカウントを作る。**登録コード**には `PAW_SIGNUP_CODE` の値を入れる（2 人目以降は登録できません）。パスワードは長めのものにしてください
2. **設定 → AI 実行基盤** に「Claude Code（サブスク）」、ログインが「OAuth トークン（サブスク）」と出ることを確認
3. **Projects** で Project を作り、Repo に `Toshipy/agents-office` を接続
4. **自動起動ルール** を **ON**（ラベルは `ai:ready`）

GitHub App の設定画面の **Advanced → Recent Deliveries** で、GitHub からの通知が届いたか（応答コード 202 など）を確認できます。

## 11. Issue から自動起動を試す

1. https://github.com/Toshipy/agents-office/issues/new で Issue を作る
   - タイトル例: `README の起動方法に pnpm のバージョン確認を追加`
   - 本文例: `「起動方法」の node -v の下に pnpm -v を追加してください。変更は README.md だけ。`
   - 右側の **Labels** で `ai:ready` を付ける（ラベルが無ければ、その場で作成できます）
2. `<公開 URL>` のオフィスで Run が始まるのを確認
3. 終わると Draft PR ができます。GitHub で PR を開いて:
   - **Request changes**（コメントで指示）→ AI が同じ PR を修正
   - **Approve** → Run は完了
   - **マージ** は人が行います（マージすると Run は完了、マージせずに閉じると中止）

このリポジトリの既定ブランチは `claude/intelligent-keller-3gj7mv` なので、AI の PR はこのブランチ向けになります。

## うまくいかないとき

| 症状 | 確かめること |
|---|---|
| `<公開 URL>` が開けない | `sudo systemctl status paw`（アプリ）と `tailscale funnel status`（Funnel）。Funnel の有効化が終わっているか |
| Issue を作っても Run が始まらない | App の **Advanced → Recent Deliveries** の応答コード。401 は Webhook secret の不一致、届いていなければ Webhook URL の誤り。202 なのに始まらない場合は、Projects の自動起動 ON・ラベル名・`PAW_GITHUB_ALLOWED_USERS` を確認 |
| Run が `CLAUDE_AUTH_ERROR` | 手順 8 の確認コマンドで原因を切り分け。トークンを作り直して `/etc/paw/paw.env` を更新し `sudo systemctl restart paw` |
| Run が `GITHUB_AUTH_ERROR` | App の権限（Contents / Pull requests の Read and write）と、サーバーの秘密鍵が同じ App のものか |

ログ:

```bash
sudo journalctl -u paw -f
```

## 運用

| こと | 方法 |
|---|---|
| アプリの更新 | `sudo -iu paw` → `cd agents-office && git pull && pnpm install --frozen-lockfile && pnpm --filter @paw/web build` → `exit` → `sudo systemctl restart paw` |
| 止める・再開 | `sudo systemctl stop paw` / `sudo systemctl start paw`。EC2 自体を止めると料金は下がりますが、その間は Issue に反応しません |
| 公開をやめる | `sudo tailscale funnel reset` |
| バックアップ | `/var/lib/paw`（DB・成果物）。EBS のスナップショットでも可 |
| トークンの更新 | `claude setup-token` のトークンは 1 年有効。期限前に作り直して `/etc/paw/paw.env` を更新し `sudo systemctl restart paw` |
| 利用上限 | サブスクの利用枠は claude.ai のチャットと共有。上限に達すると Run は一時停止し、画面の「承認」から続行できます |

## 安全のための設定（このアプリ側で行っていること）

- 公開リポジトリでも、`PAW_GITHUB_ALLOWED_USERS` 以外の人の Issue・レビューでは AI は動きません。
- 画面はインターネットから開けますが、ログインが必要です。新規登録は最初の 1 人だけで、登録コード（`PAW_SIGNUP_CODE`）も必要です（`ts.net` の名前は証明書の公開ログなどから見つかる可能性があるため）。
- GitHub のトークンは必要時に発行する 1 時間ほどのもので、メモリにだけ保持します。git には askpass 経由で渡し、コマンド引数・remote URL・設定ファイルに残しません。Claude Code にも渡しません。
- push は `ai/` で始まるブランチだけ・強制 push なし・git フック無効。PR は Draft のみ。マージ・Secrets・ブランチ保護の操作は常に拒否します。
- GitHub App の権限（Contents / Pull requests の書き込み）は GitHub の仕組み上マージも可能な権限なので、対象リポジトリの既定ブランチに**ブランチ保護（PR とレビュー必須）**を設定しておくと安全です。
- Claude Code はシェルを使えない設定で動き、ファイル操作は Run 専用の作業コピーの中だけです。CI 設定・git フック・`.claude/` などへの変更は取り込みません。
- テストコマンドはサーバー上でそのまま実行されます（コンテナ隔離は未実装）。信頼できるリポジトリにだけ設定してください。

---

## 付録: ドメインがある場合（Caddy で HTTPS）

Tailscale Funnel の代わりに Caddy を使う場合:

- セキュリティグループで 80・443 を開け、Elastic IP をドメインの A レコードに向ける
- Caddy を公式の手順でインストール: https://caddyserver.com/docs/install#debian-ubuntu-raspbian
- `deploy/aws/Caddyfile` を `/etc/caddy/Caddyfile` にコピーし、`paw.example.com` を自分のドメインに書き換えて `sudo systemctl reload caddy`
- `PAW_PUBLIC_URL` と GitHub App の Webhook URL をそのドメインにする
