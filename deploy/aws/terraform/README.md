# Terraform で AWS に作る（EC2 1 台 + Tailscale・tailnet 内だけ公開）

[手作業の手順](../README.md) と同じ構成を、Terraform と起動時スクリプトでまとめて作ります。

| 作るもの | 内容 |
|---|---|
| VPC・サブネット・インターネットゲートウェイ | このアプリ専用。既定の VPC は使わない |
| セキュリティグループ | **受信はすべて拒否**（外向きの通信だけ） |
| EC2 | Ubuntu 24.04（Arm）、`t4g.medium`、30GB（暗号化）、IMDSv2 のみ |
| IAM ロール | Session Manager で入るための権限と、`/paw/*` の秘密情報を読む権限だけ |
| 起動時スクリプト | Node.js・Docker・Claude Code・アプリ・Tailscale を入れ、`tailscale serve` で tailnet 内だけに公開し、Tester 用の Docker ネットワーク（`paw-test`）と通信制限を作り、常時起動まで自動で行う（`scripts/bootstrap.sh`） |

秘密情報（サブスクのトークン・GitHub App の秘密鍵など）は Terraform では扱いません。`scripts/put-secrets.sh` で SSM Parameter Store に入れ、サーバーが起動時に読みます。Terraform の state にも Git にも残りません。

> **確認状況:** `terraform fmt -check` と `terraform validate` は通っています。起動時スクリプトは `bash -n` で構文だけ確認しており（shellcheck は未実行）、EC2 での実機の起動は未確認です。最初の `terraform plan` や起動でエラーが出たら、そのまま貼ってください。

---

## 0. 手元の Mac の準備

まず、ターミナルが Apple Silicon（arm64）のまま動いているかを確認します:

```bash
uname -m
```

`arm64` なら OK です。`x86_64` と出る場合は、ターミナルが Rosetta 2（Intel 用の互換モード）で動いていて、Homebrew が `Cannot install under Rosetta 2 in ARM default prefix` で止まります。次のどちらかで対処してください。

- **おすすめ:** ターミナルを終了 → Finder の「アプリケーション → ユーティリティ → ターミナル」を右クリック →「情報を見る」→ **「Rosetta を使用して開く」のチェックを外す** → ターミナルを開き直して `uname -m` が `arm64` になったことを確認
- **一時的に:** 以下の `brew` コマンドの先頭に `arch -arm64` を付けて実行する（例: `arch -arm64 brew install hashicorp/tap/terraform`）

Homebrew が `Your Command Line Tools (CLT) does not support macOS …` で止まる場合は、Xcode の Command Line Tools が今の macOS に対応していません。

- **おすすめ:** 「システム設定 → 一般 → ソフトウェアアップデート」で Command Line Tools を更新する。更新が出てこない場合は、Homebrew の案内どおり `sudo rm -rf /Library/Developer/CommandLineTools` → `sudo xcode-select --install` で入れ直す（入れ直しが終わるまで `git` なども使えなくなります）
- **Homebrew を使わない方法:** Terraform は 1 つの実行ファイルなので、HashiCorp の配布サイト（https://releases.hashicorp.com/terraform/）から `darwin_arm64` の zip を取得して、中の `terraform` を PATH の通った場所に置いても使えます

Terraform（HashiCorp の公式 tap）:

```bash
brew tap hashicorp/tap
```

```bash
brew install hashicorp/tap/terraform
```

Session Manager でサーバーに入るためのプラグイン:

```bash
brew install --cask session-manager-plugin
```

AWS CLI の認証確認（アカウント ID が出れば OK）:

```bash
aws sts get-caller-identity
```

## 1. Tailscale の準備（ブラウザ）

1. https://login.tailscale.com でアカウントを作る（GitHub アカウントでも可）
2. 管理画面の **Settings → Keys → Generate auth key** で認証キーを作る（`tskey-auth-…`）。手順 3 で使うので、画面を閉じる前にコピー
3. HTTPS 証明書の有効化は、初回にサーバー側で求められることがあります（手順 6 で確認します）。ブラウザを開く PC・スマホにも Tailscale を入れてログインしておく

## 2. GitHub App とサブスクのトークン

1. **agents-office 専用の GitHub App を新しく作る**（他の App は使い回さない）。https://github.com/settings/apps/new で次のとおりにする:
   - **Webhook: Active のチェックを外す**（Webhook は受けません。サーバーが 60 秒ごとに GitHub を見に行きます）
   - **Repository permissions**: Contents / Pull requests / Issues を **Read and write**、Metadata を Read-only
   - イベントの購読は不要
2. 作成後、**General → Private keys → Generate a private key** で鍵を作る（サーバー用）。App ID は **General → About** の数字
3. 作る場所: **組織（`fenrir-inc` など）のリポジトリを扱うなら組織の Settings → Developer settings → GitHub Apps で作る**（Only on this account は組織を指す）。個人アカウントで作るなら **Any account** にして組織の承認を受ける。個人で Only on this account にすると組織のリポジトリには入れられない
4. **Install App** で、**Only select repositories** を選び、AI に任せるリポジトリだけに入れる。組織（`fenrir-inc` など）のリポジトリには、**組織のオーナーの承認**が要る（リクエストを出して承認してもらう）。案件が増えたらここにリポジトリを足し、画面の Projects で Repo を接続する
5. 別のターミナルでサブスクのトークンを作る（ブラウザで承認すると表示される）

```bash
claude setup-token
```

## 3. 秘密情報を SSM Parameter Store に入れる

```bash
cd ~/Documents/agents-office/deploy/aws/terraform
```

```bash
./scripts/put-secrets.sh
```

聞かれた順に、サブスクのトークン・秘密鍵のパス・Tailscale の認証キーを入れます。最後に **登録コード** が表示されるので控えてください（手順 7 で使います）。

## 4. Terraform で作る

```bash
cp terraform.tfvars.example terraform.tfvars
```

`terraform.tfvars` の `github_app_id` を App ID（General → About の数字）に書き換えます。`github_allowed_users` は `Toshipy` のままで OK です。

```bash
terraform init
```

```bash
terraform plan
```

作られるものを確認してから:

```bash
terraform apply
```

## 5. 起動時の準備が終わるのを待つ（10 分ほどの見込み）

サーバーに入ります（`terraform apply` の最後に表示される `connect` のコマンド）:

```bash
aws ssm start-session --region ap-northeast-1 --target <instance_id>
```

進み具合を見ます。`起動時の準備が終わりました` と出れば完了です（Ctrl+C で抜ける）:

```bash
sudo tail -f /var/log/paw-bootstrap.log
```

途中の `Claude Code の確認` の行で、サブスクのトークンで動くか、制限モードを使えるかが分かります。

## 6. 公開設定を確認する（サーバー上）

```bash
tailscale serve status
```

公開 URL（`https://paw.….ts.net`）が表示され、`Funnel on` と出ていなければ OK です（tailnet 内だけの公開）。ログに「tailscale serve を設定できませんでした」と出ていた場合は、次を実行して表示されたリンクから HTTPS 証明書を有効にし、もう一度実行してください。**`tailscale funnel` は使わないでください**（インターネットに公開されます）:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Tester 用のネットワークと通信制限（起動時に `paw.service` が毎回確認します）:

```bash
sudo docker network ls | grep paw-test && sudo iptables -t raw -S PAW-TEST
```

Tester の通信制限は、実機で次を確認してください（初回と、`sudo reboot` のあとにもう一度）。コマンドと期待する結果は [../README.md](../README.md) の手順 4b にあります（`getent hosts registry.npmjs.org` が成功し、`169.254.169.254` と tailnet の IP への `curl` が失敗すること）。

公開 URL は手元の Mac からも確認できます:

```bash
aws ssm get-parameter --region ap-northeast-1 --name /paw/public_url --query Parameter.Value --output text
```

**鍵の有効期限を切る:** Tailscale の管理画面（Machines）で `paw` の「…」メニューから **Disable key expiry** を選んでおくと、半年ほどで接続が切れるのを防げます（Tailscale の既定の期限は記憶ベースで、未確認です）。

## 7. 設定の確認

GitHub の Webhook は使わないので、App 側で設定することはありません（Webhook は無効のままにしておく）。サーバーの `/etc/paw/paw.env` には、起動時スクリプトが次を入れています。

- `PAW_SIGNUP=first_user`・`PAW_SEED_DEMO=0`・`PAW_DEV_ROUTES=0`・`PAW_CLAUDE_CODE_RESTRICTED=1`（常に 1 です。`--restricted` の確認が失敗してもログに出すだけで、0 にはしません。0 だと起動を拒むため、トークンなどの原因を直します）
- `PAW_GITHUB_LOGIN`（`github_allowed_users` の先頭）・`PAW_GITHUB_POLL_MS=60000`
- `PAW_TEST_SANDBOX=docker`・`PAW_TEST_IMAGE=node:22-bookworm`・`PAW_TEST_NETWORK=paw-test`

**Docker の権限:** `paw` ユーザーは Tester のコンテナを起動するため `docker` グループに入っています。このグループはホストの root と同等の権限です。理由と対策は [../README.md](../README.md) の「Docker の権限」を読んでください。

## 8. 使い始める（ブラウザ。tailnet に入っている端末から）

1. `<公開 URL>` を開き、**新規登録**。**登録コード**に手順 3 で表示された値を入れる（2 人目以降は登録できません）
2. **設定 → AI 実行基盤** に「Claude Code（サブスク）」と出ることを確認
3. **Projects** で Project を作り、App を入れたリポジトリを接続する
4. **Issue 一覧**にそのリポジトリの Issue が出ることを確認する（最大 60 秒）
5. 影響の小さい Issue を 1 つ選び、「AI に任せる」を押す（または GitHub で `agents-office` ラベルを付ける）
6. 計画・実装・AI レビューの後に出る「GitHub に出す」の承認カードで、差分を確かめて承認する（承認までは push も PR も行われません）
7. PR ができる（本文 1 行目は `Closes #<番号>`）。マージは人が行う

詳しい確認と、うまくいかないときは [../README.md](../README.md) の手順 11 と「うまくいかないとき」を見てください。

## 以前の版で作ったインスタンスの移行

以前の bootstrap（Funnel で公開する版）で作った EC2 は、そのままでは新しい構成になりません。起動時スクリプトの変更は既存のインスタンスに反映されず（`ignore_changes = [user_data]`）、`paw-update` も古いままです。次のどちらかにします。

- **作り直す（簡単）:** `terraform apply -replace=aws_instance.this`。**DB・成果物は消えます**。必要なら先に `/var/lib/paw` のスナップショットを取る
- **その場で直す:** サーバーで `sudo tailscale funnel reset`（インターネット公開を止める）→ `sudo tailscale serve --bg --https=443 http://127.0.0.1:8787` → `docker.io` と `iptables` を入れ、`sudo usermod -aG docker paw` → [../README.md](../README.md) の手順 4b（スクリプトの配置と実行）→ `paw.env` に `PAW_GITHUB_LOGIN`・`PAW_GITHUB_POLL_MS`・`PAW_TEST_SANDBOX=docker` などを足し、`PAW_GITHUB_WEBHOOK_SECRET` を消す → 新しい `paw.service` を `/etc/systemd/system/` に置いて `sudo systemctl daemon-reload && sudo systemctl restart paw`。以後の `paw-update` は、新しい版で置き直した後のものを使う（古い `paw-update` は通信制限スクリプトを入れ直さない）

---

## 運用

| こと | コマンド（サーバーに入ってから） |
|---|---|
| アプリを最新にする | `sudo paw-update`（この版の bootstrap で作ったインスタンスでは、通信制限のスクリプトと `paw.service` も入れ直します） |
| 秘密情報を更新した後 | `sudo paw-config-sync && sudo systemctl restart paw` |
| ログを見る | `sudo journalctl -u paw -f` |
| 起動時の準備をやり直す | `sudo bash /var/lib/cloud/instance/user-data.txt` |

| こと | コマンド（手元の Mac） |
|---|---|
| 一時的に止める（料金を下げる） | `aws ec2 stop-instances --region ap-northeast-1 --instance-ids <instance_id>`（止めている間は Issue に反応しません） |
| 再開 | `aws ec2 start-instances --region ap-northeast-1 --instance-ids <instance_id>` |
| 全部消す | `terraform destroy`（**DB・成果物も消えます**。SSM の秘密情報は残るので、不要なら `aws ssm delete-parameters` で消す） |

起動時スクリプトや AMI を変えても、Terraform は既存の EC2 を作り直しません（データを守るため `ignore_changes` にしています）。作り直したいときは `terraform apply -replace=aws_instance.this` を使いますが、データは消えます。

料金は EC2（t4g.medium）と EBS（30GB）が主です。AWS の料金ページで確認してください。
