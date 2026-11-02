# AWS（EC2 1 台）＋ Tailscale で常時動かす手順

PC を閉じていても、GitHub の Issue に `agents-office` ラベルを付ける（または一覧から「AI に任せる」）と AI が作業し、承認を経て PR を作る構成です。利用者は自分 1 人、AI は Claude のサブスク（Pro など）を使います。
画面は **Tailscale のネットワーク（tailnet）の中だけ**で開きます。インターネットには公開しません（Tailscale Funnel は使いません）。ドメインも不要で、HTTPS の URL（`https://<名前>.<tailnet名>.ts.net`）は `tailscale serve` が用意します。

> **Terraform でまとめて作る場合は [terraform/README.md](terraform/README.md) を使ってください。** EC2 の作成からアプリの起動までを自動で行い、SSH の代わりに Session Manager で入ります。以下は同じ構成を手作業で作る手順です。

```text
ブラウザ（tailnet 内の端末）──HTTPS──▶ tailscale serve ──▶ API :8787（127.0.0.1 のみ）──▶ Claude Code CLI（サブスクのトークン）
                                                              │  ▲
                              60 秒ごとに GitHub を見に行く（ポーリング）│  │ テストコマンドだけ Docker（paw-test ネットワーク）で実行
GitHub ◀── 承認後だけ push・PR・Issue コメント（GitHub App の短期トークン）──┘
```

EC2 は外からの接続を受け付けません（受信ポートは SSH だけ、それも自分の IP に限定）。GitHub からの Webhook も受けず、サーバーが GitHub を定期的に見に行くので、インターネットから届く口はありません。

> **確認状況**
> - アプリ: 利用者の Mac で、本物の GitHub とサブスクの Claude Code を使い「依頼 → 計画 → 実装 → AI レビュー → GitHub に Draft PR」まで動作を確認済み（旧構成）。Issue のポーリング、承認後の PR 作成、Docker の Tester は、テストまでの確認で、EC2 での実機は未確認です（手順 12 の確認で確かめてください）。
> - Tailscale: コマンドは Tailscale の CLI のヘルプ文で確認した範囲です。`tailscale serve` の構文（`--bg --https=443 http://127.0.0.1:8787`）と、HTTPS 証明書の有効化の画面は実機で未確認です。表示が手順と違う場合は、画面の案内を優先してください。

## 必要なもの

| もの | 理由 |
|---|---|
| AWS アカウント | EC2 1 台 |
| Tailscale アカウント（無料の個人プランで可） | tailnet 内の HTTPS の URL（`tailscale serve`）を作る。GitHub アカウントでサインアップできる。ブラウザを開く PC・スマホにも Tailscale を入れる |
| GitHub App | agents-office 専用に新しく作る（手順 5） |
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
sudo apt update && sudo apt install -y git curl ca-certificates iptables docker.io
```

Docker は Tester（AI が書いたテストを動かす場所）に使います。起動を確認します:

```bash
sudo systemctl enable --now docker
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

`paw` が Tester のコンテナを起動できるようにします（**docker グループはホストの root と同等の権限です。下の「Docker の権限」を読んでから入れてください**）:

```bash
sudo usermod -aG docker paw
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

## 4. Tailscale で tailnet 内だけの HTTPS の URL を作る（サーバー上）

Tailscale を入れます（Tailscale が案内している Linux 用のインストールスクリプト）:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

サーバーを自分の Tailscale につなぎます。表示される URL をブラウザで開いてログインしてください。`--hostname=paw` で URL の先頭が `paw` になります:

```bash
sudo tailscale up --hostname=paw
```

アプリ（127.0.0.1:8787）を **tailnet 内だけ**に公開します（`--bg` でバックグラウンドに常駐し、再起動後も設定が残ります）:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

初めて使うときは、HTTPS 証明書をこの tailnet で有効にするよう求められることがあります。表示されたリンクを開いて有効にし、もう一度同じコマンドを実行してください。**`tailscale funnel` は実行しないでください**（インターネットに公開されます。以前 Funnel を使っていた場合は `sudo tailscale funnel reset` で止めます）。

公開 URL を確認します（`https://paw.<tailnet名>.ts.net` のような URL が表示されます。以降 `<公開 URL>` と書きます。`Funnel on` と出ていなければ、インターネットには公開されていません）:

```bash
tailscale serve status
```

アプリはまだ起動していないので、この時点で URL を開くとエラーになるのは正常です。

**鍵の有効期限を切る:** Tailscale の端末の鍵には有効期限があり（既定は 180 日だったはず。未確認）、切れるとサーバーが Tailscale から外れて URL も開けなくなります。Tailscale の管理画面（https://login.tailscale.com/admin/machines）で `paw` の「…」メニューから **Disable key expiry** を選んでおいてください。

## 4b. Tester 用の Docker ネットワークを作る（サーバー上）

Tester は、AI が書き換えたテストやスクリプトを動かします。秘密（`/etc/paw/paw.env`・GitHub App の秘密鍵）が見えないよう、作業コピーだけをマウントしたコンテナで動かし、そのコンテナからホストと内部ネットワークへ届かないようにします。依存の取得のためインターネットへは出られます。

制限は root 所有のスクリプトで入れ、`paw.service` が起動のたびに実行します（`paw` が書き換えられない場所に置きます）:

```bash
sudo install -o root -g root -m 755 /home/paw/agents-office/deploy/aws/paw-test-network.sh /usr/local/sbin/paw-test-network
```

```bash
sudo /usr/local/sbin/paw-test-network
```

`paw-test`（172.31.250.0/24）のネットワークができ、そこからの通信のうち、`10.0.0.0/8`・`172.16.0.0/12`・`192.168.0.0/16`・`169.254.0.0/16`（メタデータを含む）・`100.64.0.0/10`（tailnet）への転送と、ホスト自身への通信が落とされます。何度実行しても同じ状態になります。確認:

```bash
sudo iptables -S DOCKER-USER && sudo iptables -S INPUT | grep 172.31.250
```

Tester のイメージを先に取得しておきます:

```bash
sudo docker pull node:22-bookworm
```

### Docker の権限

`docker` グループに入れたユーザーは、ホストの root と同等の操作ができます（任意のパスをマウントしたコンテナを作れるため）。この構成は、`paw` ユーザー（API と Claude Code が動く）をこのグループに入れます。

- 採った理由: Tester を「コンテナに閉じ込めて、ホストの内部ネットワークへ出さない」には、ホスト側の iptables（`DOCKER-USER`）で縛れる通常の Docker が必要です。rootless Docker はネットワークがユーザー空間で動き、この規則が使えず、`169.254.169.254` や tailnet を落とす手段が弱くなるため採りませんでした。
- 残るリスク: `paw` として任意のコードが動けば、ホスト全体を奪えます。そのため、AI は `--restricted`（Bash などコードを動かすツールなし）で動かし、`docker` を呼ぶのはアプリだけ（引数はアプリが固定。作業コピーだけをマウント、`--cap-drop` 等で権限を落とす）にしています。EC2 自体も受信ポートなし・tailnet 内だけの公開です。
- もっと強くしたいとき: Tester だけ別のホスト・別の VM に分ける（このリポジトリでは未対応）。

## 5. GitHub App を作る（ブラウザ）

**agents-office 専用の App を新しく作ります**（meeting-note など他の App は使い回しません。秘密鍵は AI が動く EC2 に置くため、漏れたときの範囲を絞ります）。https://github.com/settings/apps/new（組織のものにするなら組織の Settings → Developer settings → GitHub Apps）を開きます。

1. **GitHub App name**: 例 `agents-office-<自分の名前>`。**Homepage URL**: 適当な URL（このリポジトリの URL など）
2. **Webhook**: **Active のチェックを外す**（Webhook は受けません。サーバーが 60 秒ごとに GitHub を見に行きます）
3. **Permissions → Repository permissions**:

   | 権限 | 設定 |
   |---|---|
   | Contents | Read and write |
   | Pull requests | Read and write |
   | Issues | Read and write |
   | Metadata | Read-only（自動で付く） |

   イベントの購読（Subscribe to events）は不要です。
4. **Where can this GitHub App be installed?**: 自分のアカウントだけで使うなら **Only on this account**
5. **Create GitHub App** のあと、**General → Private keys → Generate a private key** で鍵を作る（ダウンロードされる .pem はサーバー用。手元に残さない）
6. App ID は **General → About** の数字
7. **Install App** で、対象のリポジトリに入れます。**Only select repositories** を選び、AI に任せたいリポジトリだけを選びます（案件が増えたらここに足し、画面の Projects で Repo を接続します）
8. 組織（例 `fenrir-inc`）のリポジトリに入れる場合は、**組織のオーナーの承認**が必要です。インストールのリクエストを出し、オーナーに承認してもらってください

## 6. 秘密鍵とサブスクのトークンを用意する（手元の Mac）

手順 5 でダウンロードした秘密鍵をサーバーへ送ります（ファイル名は実際のものに置き換える）:

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
| `PAW_GITHUB_ALLOWED_USERS` | `Toshipy`（この人の Issue・レビューだけを受け付ける） |
| `PAW_GITHUB_LOGIN` | `Toshipy`（「自分担当」の Issue を判定するログイン名） |

`PAW_TEST_SANDBOX=docker`・`PAW_TEST_NETWORK=paw-test`・`PAW_GITHUB_POLL_MS=60000` などは `paw.env.example` のままで構いません。`PAW_GITHUB_WEBHOOK` と `PAW_GITHUB_WEBHOOK_SECRET` は**書きません**（開発用。書くと署名付き Webhook の受け口が有効になります。本番では不要です）。

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

## 10. 使い始める（ブラウザ。tailnet に入っている端末から）

1. 起動したらすぐに `<公開 URL>` を開き、**新規登録**で自分のアカウントを作る。**登録コード**には `PAW_SIGNUP_CODE` の値を入れる（2 人目以降は登録できません）。パスワードは長めのものにしてください
2. **設定 → AI 実行基盤** に「Claude Code（サブスク）」、ログインが「OAuth トークン（サブスク）」と出ることを確認
3. **Projects** で Project を作り、Repo を接続（インストール済みのリポジトリだけ選べます）

## 11. 起動後の確認（初回）

順に確かめます。どこかで止まったら「うまくいかないとき」を見てください。

1. **ログイン**: 最初のユーザー（`first_user`）として登録コードで登録できる。ログアウトして入り直せる
2. **Repo の接続**: Projects で GitHub App を入れたリポジトリを接続できる（入れていないと選べない）
3. **Issue 一覧**: 接続した案件の画面に、そのリポジトリの Issue が出る（反映まで最大 60 秒）
4. **1 件を任せる**: 影響の小さい Issue（例: README の 1 行追加）を 1 つ選び、一覧の「AI に任せる」を押す。または GitHub で Issue に `agents-office` ラベルを付ける。Issue に自分がアサインされ、Run が始まる
5. **承認**: 計画・実装・AI レビューの後、「GitHub に出す」の承認カードが出る。**差分を確かめて承認**する（承認するまで push も PR もコメントも行われません）
6. **PR**: 承認すると PR が作られる（本文 1 行目は `Closes #<番号>`）。GitHub で開いて確認し、マージは人が行う。Run は完了し、Issue の `agents-office` ラベルとアサインが外れる

Tester が動いているか（Run のテスト工程の後）:

```bash
sudo docker ps -a --filter network=paw-test
```

失敗したときは `sudo journalctl -u paw -n 100 --no-pager`。サーバーモードで Docker が使えないと、Tester を動かさず Run を失敗にします。

## うまくいかないとき

| 症状 | 確かめること |
|---|---|
| `<公開 URL>` が開けない | 開く端末が tailnet に入っているか。`sudo systemctl status paw`（アプリ）と `tailscale serve status`（公開設定）。HTTPS 証明書の有効化が終わっているか |
| Issue 一覧が空・Run が始まらない | Projects の Repo 接続と自動起動 ON、`agents-office` ラベル名、`PAW_GITHUB_ALLOWED_USERS` / `PAW_GITHUB_LOGIN`。App がそのリポジトリに入っているか（Install App）。`journalctl` に GitHub のポーリングのエラーが出ていないか。組織のオーナーが App を承認したか |
| 起動直後に落ちる | `journalctl -u paw` に「起動を拒みます」系の行がないか（サーバーモードは `PAW_SIGNUP=open`・デモ・開発用ルート・`PAW_CLAUDE_CODE_RESTRICTED=0`・`PAW_TEST_SANDBOX=host` を拒みます） |
| テスト工程で失敗する | `sudo systemctl status docker`、`id paw` に docker があるか（なければ `sudo usermod -aG docker paw` → `sudo systemctl restart paw`）、`sudo /usr/local/sbin/paw-test-network` が通るか、`sudo docker pull node:22-bookworm` |
| Run が `CLAUDE_AUTH_ERROR` | 手順 8 の確認コマンドで原因を切り分け。トークンを作り直して `/etc/paw/paw.env` を更新し `sudo systemctl restart paw` |
| Run が `GITHUB_AUTH_ERROR` | App の権限（Contents / Pull requests / Issues の Read and write）と、サーバーの秘密鍵が同じ App のものか |

ログ:

```bash
sudo journalctl -u paw -f
```

## 運用

| こと | 方法 |
|---|---|
| アプリの更新 | `sudo -iu paw` → `cd agents-office && git pull && pnpm install --frozen-lockfile && pnpm --filter @paw/web build` → `exit` → `sudo install -o root -g root -m 755 /home/paw/agents-office/deploy/aws/paw-test-network.sh /usr/local/sbin/paw-test-network` → `sudo systemctl restart paw` |
| 止める・再開 | `sudo systemctl stop paw` / `sudo systemctl start paw`。EC2 自体を止めると料金は下がりますが、その間は Issue に反応しません |
| 公開をやめる | `sudo tailscale serve reset` |
| バックアップ | `/var/lib/paw`（DB・成果物）。EBS のスナップショットでも可 |
| トークンの更新 | `claude setup-token` のトークンは 1 年有効。期限前に作り直して `/etc/paw/paw.env` を更新し `sudo systemctl restart paw` |
| 利用上限 | サブスクの利用枠は claude.ai のチャットと共有。上限に達すると Run は一時停止し、画面の「承認」から続行できます |

## 安全のための設定（このアプリ側で行っていること）

- 画面は tailnet の中だけで開けます（インターネットには出しません）。ログインが必要で、新規登録は最初の 1 人だけ、登録コード（`PAW_SIGNUP_CODE`）も必要です。
- GitHub の Webhook は受けません。外から入る口は無く、サーバーが GitHub を見に行きます。`PAW_GITHUB_ALLOWED_USERS` 以外の人の Issue・レビューでは AI は動きません。
- GitHub への書き込み（push・PR 作成・Issue コメント・ラベルの付け替え）は、画面の承認（`publish`）の後にだけ行います。失敗・中止での `agents-office` ラベルとアサインの取り外しだけは承認なしで行います。
- GitHub のトークンは必要時に発行する 1 時間ほどのもので、メモリにだけ保持します。git には askpass 経由で渡し、コマンド引数・remote URL・設定ファイルに残しません。Claude Code にも渡しません。
- push は `ai/` で始まるブランチだけ・強制 push なし・git フック無効。マージ・Secrets・ブランチ保護の操作は常に拒否します。
- GitHub App の権限（Contents / Pull requests の書き込み）は GitHub の仕組み上マージも可能な権限なので、対象リポジトリの既定ブランチに**ブランチ保護（PR とレビュー必須）**を設定しておくと安全です。
- Claude Code はシェルを使えない設定（`--restricted`）で動き、ファイル操作は Run 専用の作業コピーの中だけです。CI 設定・git フック・`.claude/` などへの変更は取り込みません。
- テストコマンドは Docker コンテナの中で動きます（作業コピーだけをマウント。秘密のファイルと環境変数は無し。ホスト・内部ネットワーク・tailnet には届かない）。サーバーモードで Docker が使えないときは Run を失敗にします。`docker` グループのリスクは手順 4b を読んでください。

---

## 付録: ドメインがある場合

この構成は tailnet 内だけの公開を前提にしています。インターネットに公開するドメイン構成（Caddy など）は、Webhook を受けない設計にしたため、手順を置いていません。必要になったときは、先に設計の「公開範囲」を見直してください。
