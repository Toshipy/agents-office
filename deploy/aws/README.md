# AWS（EC2 1 台）で常時動かす手順

PC を閉じていても、GitHub の Issue にラベルを付けると AI が作業し、Draft PR を作る構成です。利用者は自分 1 人、AI は Claude のサブスク（Pro など）を使います。

```text
GitHub ──Webhook(HTTPS)──▶ Caddy :443 ──▶ API :8787（127.0.0.1 のみ）──▶ Claude Code CLI（サブスクのトークン）
   ▲                                          │
   └────────── push（ai/ ブランチ）・Draft PR ◀─┘（GitHub App の短期トークン）
ブラウザ ──HTTPS──▶ Caddy ──▶ 画面（ログイン必須・新規登録は最初の 1 人だけ）
```

> **確認状況**: この手順とアプリの GitHub 連携は、GitHub API のモックと git の bare リポジトリを使ったテストまでで確認しています。
> 実際の AWS・GitHub・サブスクでの動作は未確認です。うまくいかない箇所があれば、ログ（`journalctl -u paw`）を教えてください。

## 必要なもの

| もの | 理由 |
|---|---|
| AWS アカウント | EC2 1 台 |
| **ドメイン**（例 `paw.example.com`） | GitHub の Webhook と画面を HTTPS で受けるため（証明書は Caddy が Let's Encrypt から自動取得） |
| GitHub アカウント | GitHub App を作ってリポジトリにインストールする |
| Claude のサブスク（Pro 以上） | `claude setup-token` でサーバー用のトークンを作る |

## 1. EC2 を作る

| 項目 | 推奨 |
|---|---|
| OS | Ubuntu Server 24.04 LTS |
| インスタンスタイプ | メモリ 4GB 以上（Claude Code の公式要件）。例: `t4g.medium`（ARM）/ `t3.medium`（x86） |
| ストレージ | 30GB 以上（リポジトリのクローンと作業コピー、テスト用の依存関係を置く） |
| セキュリティグループ | 443・80: どこからでも（GitHub の Webhook と証明書の取得）。22: 自分の IP だけ（または SSM Session Manager を使い 22 は閉じる） |
| Elastic IP | 割り当てて、ドメインの A レコードをこの IP に向ける |

テストコマンド（例: `pnpm test`）もこのサーバーで動くため、重いテストがあるリポジトリはメモリに余裕を持たせてください。

## 2. サーバーの準備

SSH でログインし、以下を順に実行します。

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

Caddy（HTTPS のリバースプロキシ）は公式の手順でインストールしてください: https://caddyserver.com/docs/install#debian-ubuntu-raspbian

アプリを動かす専用ユーザーとデータ置き場:

```bash
sudo useradd -m -s /bin/bash paw
```

```bash
sudo mkdir -p /var/lib/paw /etc/paw && sudo chown paw:paw /var/lib/paw && sudo chmod 700 /var/lib/paw
```

## 3. アプリと Claude Code を入れる（paw ユーザーで）

```bash
sudo -iu paw
```

Claude Code（公式のインストーラー。`~/.local/bin/claude` に入る）:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

アプリ本体（リポジトリが非公開の場合は、デプロイキーなどで取得してください）:

```bash
git clone https://github.com/Toshipy/agents-office.git
```

```bash
cd agents-office && git checkout claude/intelligent-keller-3gj7mv
```

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm --filter @paw/web build
```

```bash
exit
```

## 4. GitHub App を作る

GitHub の **Settings → Developer settings → GitHub Apps → New GitHub App** で作成します。

| 項目 | 値 |
|---|---|
| GitHub App name | 任意（例: `toshipy-ai-workspace`） |
| Homepage URL | `https://paw.example.com` |
| Webhook URL | `https://paw.example.com/integrations/github/webhook` |
| Webhook secret | 下のコマンドで作った値（後で `PAW_GITHUB_WEBHOOK_SECRET` にも同じ値を入れる） |
| Repository permissions | **Contents: Read and write**（ブランチの push）/ **Pull requests: Read and write**（Draft PR の作成）/ **Issues: Read-only**（Issue の内容）/ Metadata: Read-only（必須） |
| Subscribe to events | **Issues** / **Pull request** / **Pull request review** |
| Where can this GitHub App be installed? | **Only on this account** |

```bash
openssl rand -hex 32
```

作成後:
1. 画面に出る **App ID** を控える。
2. **Generate a private key** で秘密鍵（.pem）をダウンロードし、サーバーの `/etc/paw/github-app.pem` に置く。手元の PC から送る例（ファイル名・ホスト名は置き換える）:

```bash
scp ~/Downloads/your-app.private-key.pem ubuntu@paw.example.com:/tmp/github-app.pem
```

サーバー側で:

```bash
sudo mv /tmp/github-app.pem /etc/paw/github-app.pem && sudo chown root:paw /etc/paw/github-app.pem && sudo chmod 640 /etc/paw/github-app.pem
```

3. **Install App** から、AI に作業させたいリポジトリだけを選んでインストールする。

このアプリにはマージを行う処理がなく、Tool Broker でも常に拒否します。ただし上の権限（Contents / Pull requests の書き込み）は GitHub の仕組み上マージも可能な権限なので、念のため対象リポジトリの既定ブランチに**ブランチ保護（PR とレビュー必須）**を設定しておくことをおすすめします。

## 5. サブスクのトークンを作る（手元の PC で）

```bash
claude setup-token
```

ブラウザで承認すると、1 年間有効なトークンが表示されます（どこにも保存されません）。次の設定ファイルに貼り付けます。
このトークンは Claude のサブスクを使える鍵なので、他の人に見せたり Git にコミットしたりしないでください。

## 6. 設定ファイル

`deploy/aws/paw.env.example` を `/etc/paw/paw.env` にコピーして値を埋めます。

```bash
sudo cp /home/paw/agents-office/deploy/aws/paw.env.example /etc/paw/paw.env
```

```bash
sudo chown root:paw /etc/paw/paw.env && sudo chmod 640 /etc/paw/paw.env
```

```bash
sudo nano /etc/paw/paw.env
```

| 変数 | 入れる値 |
|---|---|
| `PAW_PUBLIC_URL` | `https://paw.example.com` |
| `PAW_SESSION_SECRET` | `openssl rand -hex 32` の出力 |
| `CLAUDE_CODE_OAUTH_TOKEN` | 手順 5 のトークン |
| `PAW_GITHUB_APP_ID` | 手順 4 の App ID |
| `PAW_GITHUB_WEBHOOK_SECRET` | 手順 4 で App に設定した Webhook secret と同じ値 |
| `PAW_GITHUB_ALLOWED_USERS` | 自分の GitHub ユーザー名（この人の Issue・レビューだけを受け付ける） |

## 7. 起動

```bash
sudo cp /home/paw/agents-office/deploy/aws/paw.service /etc/systemd/system/paw.service
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now paw
```

```bash
sudo cp /home/paw/agents-office/deploy/aws/Caddyfile /etc/caddy/Caddyfile
```

`/etc/caddy/Caddyfile` の `paw.example.com` を自分のドメインに書き換えてから:

```bash
sudo systemctl reload caddy
```

起動の確認（`agent runtime` に `claude_code`、`github app` に App ID が出ていれば OK）:

```bash
sudo journalctl -u paw -n 50 --no-pager
```

## 8. 使い始める

1. `https://paw.example.com` を開き、**新規登録**で自分のアカウントを作る（2 人目以降は登録できません）。
2. **設定 → AI 実行基盤** に「Claude Code（サブスク）」、ログインが「OAuth トークン（サブスク）」と出ることを確認。
3. **Projects** で Project を作り、Repo 欄に GitHub App をインストールしたリポジトリ（候補が出ます）を入れて接続。必要ならテストコマンドを保存。
4. 自動起動ルールを **ON**（ラベルは既定で `ai:ready`）。
5. GitHub でそのリポジトリに Issue を作り、`ai:ready` ラベルを付ける → オフィスで Run が動き始め、終わると GitHub に Draft PR ができます。
6. GitHub で PR をレビュー:
   - **Request changes**: コメントの内容で AI が同じ PR を修正
   - **Approve**: Run は完了
   - **マージ**: 人が行う（マージすると Run は完了、マージせずに閉じると中止）

## 運用

| こと | 方法 |
|---|---|
| ログ | `sudo journalctl -u paw -f` |
| アプリの更新 | `sudo -iu paw` → `cd agents-office && git pull && pnpm install --frozen-lockfile && pnpm --filter @paw/web build` → `sudo systemctl restart paw` |
| バックアップ | `/var/lib/paw`（DB・成果物）。EBS のスナップショットでも可 |
| トークンの更新 | `claude setup-token` のトークンは 1 年有効。期限前に作り直して `/etc/paw/paw.env` を更新し、`sudo systemctl restart paw` |
| 利用上限 | サブスクの利用枠は claude.ai のチャットと共有。上限に達すると Run は一時停止し、画面の「承認」から続行できます |

## 安全のための設定（このアプリ側で行っていること）

- 公開リポジトリでも、`PAW_GITHUB_ALLOWED_USERS` 以外の人の Issue・レビューでは AI は動きません。
- GitHub のトークンは必要時に発行する 1 時間ほどのもので、メモリにだけ保持します。git には askpass 経由で渡し、コマンド引数・remote URL・設定ファイルに残しません。Claude Code にも渡しません。
- push は `ai/` で始まるブランチだけ・強制 push なし・git フック無効。PR は Draft のみ。マージ・Secrets・ブランチ保護の操作は常に拒否します。
- Claude Code はシェルを使えない制限モードで動き、ファイル操作は Run 専用の作業コピーの中だけです。CI 設定・git フック・`.claude/` などへの変更は取り込みません。
- テストコマンドはサーバー上でそのまま実行されます（コンテナ隔離は未実装）。信頼できるリポジトリにだけ設定してください。

## 分かっていない・確認が必要なこと

- **Draft PR とプラン:** GitHub のプランとリポジトリの公開設定によっては、Draft PR が作れない場合があります（GitHub Free の非公開リポジトリなど）。その場合 Run は `GITHUB_REJECTED` で止まります（GitHub の正確な条件は未確認です）。
- **ドメインがない場合:** この手順はドメインがある前提です。ない場合は別の方法（Cloudflare Tunnel や Tailscale Funnel など）が必要で、手順は未作成です。
- **`--restricted` モード:** サブスクのトークン（`CLAUDE_CODE_OAUTH_TOKEN`）で動くことは未確認です。問題があれば `/etc/paw/paw.env` に `PAW_CLAUDE_CODE_RESTRICTED=0` を追加してください。
