# Terraform で AWS に作る（EC2 1 台 + Tailscale Funnel）

[手作業の手順](../README.md) と同じ構成を、Terraform と起動時スクリプトでまとめて作ります。

| 作るもの | 内容 |
|---|---|
| VPC・サブネット・インターネットゲートウェイ | このアプリ専用。既定の VPC は使わない |
| セキュリティグループ | **受信はすべて拒否**（外向きの通信だけ） |
| EC2 | Ubuntu 24.04（Arm）、`t4g.medium`、30GB（暗号化）、IMDSv2 のみ |
| IAM ロール | Session Manager で入るための権限と、`/paw/*` の秘密情報を読む権限だけ |
| 起動時スクリプト | Node.js・Claude Code・アプリ・Tailscale を入れ、Funnel で公開し、常時起動まで自動で行う（`scripts/bootstrap.sh`） |

秘密情報（サブスクのトークン・GitHub App の秘密鍵など）は Terraform では扱いません。`scripts/put-secrets.sh` で SSM Parameter Store に入れ、サーバーが起動時に読みます。Terraform の state にも Git にも残りません。

> **確認状況:** この環境では Terraform のプロバイダーを取得できなかったため、`terraform validate` は未実行です（構文と内容は目視で確認）。最初の `terraform plan` でエラーが出たら、そのまま貼ってください。起動時スクリプトは `bash -n` で構文だけ確認しています。

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
3. Funnel と HTTPS の有効化は、初回にサーバー側で求められることがあります（手順 6 で確認します）

## 2. GitHub App の秘密鍵とサブスクのトークン

1. https://github.com/settings/apps → App の **Edit** → **General → Private keys → Generate a private key**（サーバー用に新しく作る）
2. 別のターミナルでサブスクのトークンを作る（ブラウザで承認すると表示される）

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

聞かれた順に、サブスクのトークン・秘密鍵のパス・Tailscale の認証キーを入れます。最後に **Webhook secret** と **登録コード** が表示されるので控えてください（後で手順 7・8 で使います）。

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

## 6. Funnel が有効になったか確認する（サーバー上）

```bash
tailscale funnel status
```

公開 URL（`https://paw.….ts.net`）が表示されれば OK です。ログに「Funnel を有効にできませんでした」と出ていた場合は、次を実行して表示されたリンクから有効にし、もう一度実行してください:

```bash
sudo tailscale funnel --bg 8787
```

公開 URL は手元の Mac からも確認できます:

```bash
aws ssm get-parameter --region ap-northeast-1 --name /paw/public_url --query Parameter.Value --output text
```

**鍵の有効期限を切る:** Tailscale の管理画面（Machines）で `paw` の「…」メニューから **Disable key expiry** を選んでおくと、半年ほどで接続が切れるのを防げます（Tailscale の既定の期限は記憶ベースで、未確認です）。

## 7. GitHub App の Webhook を設定する（ブラウザ）

https://github.com/settings/apps → App の **Edit**

1. **General → Webhook**: **Active** にチェック、Webhook URL に `<公開 URL>/integrations/github/webhook`、Webhook secret に手順 3 で表示された値 → **Save changes**
2. **Permissions & events → Subscribe to events**: **Issues** / **Pull request** / **Pull request review** → **Save changes**

## 8. 使い始める（ブラウザ）

1. `<公開 URL>` を開き、**新規登録**。**登録コード**に手順 3 で表示された値を入れる（2 人目以降は登録できません）
2. **設定 → AI 実行基盤** に「Claude Code（サブスク）」と出ることを確認
3. **Projects** で Project を作り、`Toshipy/agents-office` を接続して、**自動起動を ON**
4. GitHub で Issue を作り、`ai:ready` ラベルを付ける → オフィスで Run が始まり、Draft PR ができる

GitHub App の **Advanced → Recent Deliveries** で、通知が届いたか（応答 202 など）を確認できます。

---

## 運用

| こと | コマンド（サーバーに入ってから） |
|---|---|
| アプリを最新にする | `sudo paw-update` |
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
