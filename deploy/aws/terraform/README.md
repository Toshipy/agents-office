# Terraform で AWS に作る（EC2 1 台 + ALB・社内 VPN の出口 IP と Google ログインで制限）

[手作業の手順](../README.md)に代わり、Terraform と起動時スクリプトでまとめて作ります。画面は社内 VPN の出口 IP からの接続に限り、さらに ALB の Google ログイン（許可は 1 アカウント）を通った人だけが開けます。Tailscale は使いません。

| 作るもの | 内容 |
|---|---|
| VPC・サブネット・インターネットゲートウェイ | このアプリ専用。既定の VPC は使わない。NAT ゲートウェイは使わない |
| ALB | 443 番だけ。受信元は `allowed_cidrs`（社内 VPN の出口 IP）。80 番は開けない。リスナーで Google ログイン（OIDC）を行う |
| ACM 証明書 | `agents-office.c.fnrr.biz` 用。DNS 検証 |
| DNS レコード | `cloud-common` アカウントの公開ゾーン `c.fnrr.biz` に、証明書の検証用とドメイン用（`manage_dns = true` のとき） |
| セキュリティグループ | EC2 の受信は **ALB のセキュリティグループからの 8787 番だけ** |
| EC2 | Ubuntu 24.04（Arm）、`t4g.medium`、30GB（暗号化）、IMDSv2 のみ |
| IAM ロール | Session Manager で入るための最小の権限と、`${ssm_prefix}/*`（既定 `/agents-office/*`）の読み取りだけ。他の SSM パラメーターは明示的に拒否（本番のシステムと同じアカウントを使うため） |
| 起動時スクリプト | Node.js・Docker・Claude Code・アプリを入れ、Tester 用の Docker ネットワーク（`paw-test`）と通信制限を作り、常時起動まで自動で行う（`scripts/bootstrap.sh`） |

```text
社内 VPN の PC・スマホ ──HTTPS──▶ ALB（allowed_cidrs だけ許可・Google ログイン）──▶ EC2 :8787（ALB からだけ）
```

構成の詳細は設計書 [../../../docs/superpowers/specs/2026-11-06-aws-alb-access-design.md](../../../docs/superpowers/specs/2026-11-06-aws-alb-access-design.md) にあります。

> **秘密情報の扱い:** Claude のトークンと GitHub App の鍵は、`scripts/put-secrets.sh` で SSM Parameter Store に入れ、サーバーが起動時に読みます。これらは Terraform の state に残りません。**一方、Google の OAuth クライアントの秘密は、Terraform が ALB のリスナーへ渡すために読むので、state に平文で入ります。** state ファイル（`terraform.tfstate`）は共有・コミットしないでください（`.gitignore` 済み。バックアップも安全な場所に限る）。
>
> Google のクライアント ID と秘密は、EC2 のロールが読めないよう `${ssm_prefix}-alb/`（既定 `/agents-office-alb/`）に置きます。

> **確認状況:** `terraform fmt -check` と `terraform validate` までは通っています。実際の `terraform apply`、EC2 での起動、社内 VPN 経由でのログインは未確認です。最初の `terraform plan` や起動でエラーが出たら、そのまま貼ってください。

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

AWS CLI の認証確認（`cloud-skuld` のアカウント ID が出れば OK。プロファイルは `AWS_PROFILE` で指定する）:

```bash
aws sts get-caller-identity
```

DNS を Terraform に書かせる場合は、`cloud-common` のプロファイルも確認します（`dns_profile` の既定値と同じ名前）:

```bash
aws sts get-caller-identity --profile cloud-common
```

## 1. Google の OAuth クライアントを作る（ブラウザ）

会社の Google Cloud で作ります。作る権限が無い場合は、管理者に依頼してください（未確認）。

1. https://console.cloud.google.com/ の **API とサービス → OAuth 同意画面** で、ユーザーの種類を **内部** にする（会社の Google アカウントだけが使える）
2. **認証情報 → 認証情報を作成 → OAuth クライアント ID** で、アプリケーションの種類を **ウェブ アプリケーション** にする
3. **承認済みのリダイレクト URI** に次を入れる

```text
https://agents-office.c.fnrr.biz/oauth2/idpresponse
```

4. 作成後に表示される **クライアント ID** と **クライアント シークレット** を控える（手順 3 で使います）

`domain_name` を変えたときは、リダイレクト URI も同じドメインに直してください。

## 2. GitHub App とサブスクのトークン

1. **agents-office 専用の GitHub App を新しく作る**（他の App は使い回さない）。https://github.com/settings/apps/new で次のとおりにする:
   - **Webhook: Active のチェックを外す**（Webhook は受けません。サーバーが平日の 9〜19 時（日本時間）に 15 分ごとに GitHub を見に行きます）
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

AWS CLI のプロファイルは `cloud-skuld` にします:

```bash
export AWS_PROFILE=cloud-skuld
```

```bash
cd ~/Documents/agents-office/deploy/aws/terraform
```

```bash
./scripts/put-secrets.sh
```

聞かれた順に、次を入れます。

1. Claude のサブスクのトークン（手順 2 で作った値）
2. GitHub App の秘密鍵（.pem）のパス
3. Google のクライアント ID とクライアント シークレット（手順 1 の値）

次の場所に SecureString で登録されます。

- `/agents-office/claude_code_oauth_token`、`/agents-office/github_app_private_key`、`/agents-office/session_secret`（自動で作る）
- `/agents-office-alb/google_client_id`、`/agents-office-alb/google_client_secret`（EC2 のロールからは読めない場所）

GitHub App の ID は秘密ではないので、手順 4 の `terraform.tfvars` に書きます。`ssm_prefix` を変えるときは、`PAW_SSM_PREFIX=/別の名前 ./scripts/put-secrets.sh` のように同じ値を渡してください。

## 4. Terraform で作る

```bash
cp terraform.tfvars.example terraform.tfvars
```

`terraform.tfvars` を編集します。

- `github_app_id`: App ID（General → About の数字）
- `github_allowed_users`: `Toshipy` のままで OK
- `allowed_cidrs`: 社内 VPN の出口 IP。IPv4 のみ。1 つ以上必須。`0.0.0.0/0` は指定できない（例: `["203.0.113.1/32"]`）
- `allowed_email`: ログインを許す Google アカウント（既定 `t.arai@fenrir.co.jp`）

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

証明書の検証には数分かかることがあります。`terraform apply` の最後に `url`・`alb_arn`・`connect` などが表示されます。

### `cloud-common` に DNS を書けないとき（2 段階の手順）

`cloud-common` のプロファイルで Route 53 に書けない場合は、`terraform.tfvars` に次を足します。

```hcl
manage_dns = false
```

1. 証明書だけ先に作る

```bash
terraform apply -target=aws_acm_certificate.this
```

2. 検証用の CNAME を出力する

```bash
terraform output certificate_validation_records
```

3. 表示された `name`・`type`・`value` を、`c.fnrr.biz` のゾーンに手で（または DNS の管理者に頼んで）登録する
4. 証明書が `ISSUED` になるまで待つ（証明書の ARN は `aws acm list-certificates --region ap-northeast-1` で探す）

```bash
aws acm describe-certificate --region ap-northeast-1 --certificate-arn <証明書の ARN> --query Certificate.Status --output text
```

5. 全体を作る

```bash
terraform apply
```

6. ドメイン `agents-office.c.fnrr.biz` を、ALB の DNS 名への CNAME として手で登録する

```bash
terraform output alb_dns_name
```

### 最初の確認: Session Manager で入れること

EC2 は SSH ではなく Session Manager で入ります。`terraform apply` が終わったら、まずこれが通ることを確認してください（`connect` の出力と同じコマンド）:

```bash
aws ssm start-session --region ap-northeast-1 --target <instance_id>
```

## 5. 起動時の準備が終わるのを待つ（10 分ほどの見込み）

サーバーに入って、進み具合を見ます。`起動時の準備が終わりました` と出れば完了です（Ctrl+C で抜ける）:

```bash
sudo tail -f /var/log/paw-bootstrap.log
```

途中の `Claude Code の確認` の行で、サブスクのトークンで動くか、制限モードを使えるかが分かります。

Tester 用のネットワークと通信制限（起動時に `paw.service` が毎回確認します）:

```bash
sudo docker network ls | grep paw-test && sudo iptables -t raw -S
```

Tester の通信制限は、実機で確認してください（初回と、`sudo reboot` のあとにもう一度）。コマンドと期待する結果は [../README.md](../README.md) にあります。

## 6. 開けることを確認する

次をすべて確かめます。

1. **社内 VPN につないだ PC** で `https://agents-office.c.fnrr.biz` を開く。Google のログイン画面が出て、`allowed_email` のアカウントでログインでき、画面が開く
2. **社内 VPN につないだスマホ**（社内用）でも同じ。ログインが通るかは未確認の項目です（設計書 11 章）
3. **VPN を切る**と、画面が開けない（接続がタイムアウトする）
4. **別の Google アカウント**でログインすると「このアカウントでは使えません」と出る（アプリが 403 を返す）
5. **EC2 の IP に直接届かない**。パブリック IP を確認して、手元の Mac から次を実行し、タイムアウトで失敗すれば OK

```bash
aws ec2 describe-instances --region ap-northeast-1 --instance-ids <instance_id> --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
```

```bash
curl -m 5 http://<EC2 のパブリック IP>:8787/v1/health
```

## 7. 設定の確認

GitHub の Webhook は使わないので、App 側で設定することはありません（Webhook は無効のままにしておく）。サーバーの `/etc/paw/paw.env` には、起動時スクリプトが次を入れています。

- `PAW_AUTH=alb_oidc`・`PAW_ALB_ARN`（`alb_arn` の出力）・`PAW_ALLOWED_EMAIL`（`allowed_email`）・`PAW_PUBLIC_URL`（`https://<domain_name>`）
- `PAW_SEED_DEMO=0`・`PAW_DEV_ROUTES=0`・`PAW_CLAUDE_CODE_RESTRICTED=1`（常に 1 です。`--restricted` の確認が失敗してもログに出すだけで、0 にはしません。0 だと起動を拒むため、トークンなどの原因を直します）
- `PAW_GITHUB_LOGIN`（`github_allowed_users` の先頭）・`PAW_GITHUB_POLL_MS=900000`（15 分）。`PAW_GITHUB_POLL_WINDOW` の既定は `Mon-Fri 09:00-19:00 Asia/Tokyo`（平日の 9 時から 19 時の手前まで。`always` で時間帯の制限なし）
- `PAW_TEST_SANDBOX=docker`・`PAW_TEST_IMAGE=node:22-bookworm`・`PAW_TEST_NETWORK=paw-test`

ログインは ALB が行うので、アプリに新規登録やパスワードはありません。初めて通ったときに、アプリがユーザーとワークスペースを作ります。

**Docker の権限:** `paw` ユーザーは Tester のコンテナを起動するため `docker` グループに入っています。このグループはホストの root と同等の権限です。理由と対策は [../README.md](../README.md) の「Docker の権限」を読んでください。

## 8. 使い始める（ブラウザ。社内 VPN につないだ端末から）

1. `https://agents-office.c.fnrr.biz` を開き、Google でログインする
2. **設定 → AI 実行基盤** に「Claude Code（サブスク）」と出ることを確認
3. **Projects** で Project を作り、App を入れたリポジトリを接続する
4. **Issue 一覧**にそのリポジトリの Issue が出ることを確認する（平日の 9〜19 時に 15 分ごとに取得するので、最大 15 分待つ。時間外は次の平日の 9 時から）
5. 影響の小さい Issue を 1 つ選び、「AI に任せる」を押す（または GitHub で `agents-office` ラベルを付ける）
6. 計画・実装・AI レビューの後に出る「GitHub に出す」の承認カードで、差分を確かめて承認する（承認までは push も PR も行われません）
7. PR ができる（本文 1 行目は `Closes #<番号>`）。マージは人が行う

---

## ALB を作り直したとき・設定を変えたとき

EC2 は `user_data` の変更を無視します（`ignore_changes = [ami, user_data]`。データを守るため）。次の変更は、**`terraform apply` だけでは EC2 に反映されません。**

- ALB を作り直した（`alb_arn` が変わった）
- `allowed_email` を変えた
- `domain_name` を変えた

サーバーに入って、`/etc/paw-bootstrap/settings` の該当の行（`PAW_ALB_ARN`・`PAW_ALLOWED_EMAIL`・`PAW_DOMAIN`）を直し、設定を読み直して再起動します:

```bash
sudo nano /etc/paw-bootstrap/settings
```

```bash
sudo paw-config-sync && sudo systemctl restart paw
```

ARN が違うままだと、アプリは ALB の署名を確かめられず、全員が 401 になります。

## 以前の版で作ったインスタンスの移行

以前の bootstrap（旧構成の版）で作った EC2 は、そのままでは新しい構成になりません。起動時スクリプトの変更は既存のインスタンスに反映されず、`paw-update` も古いままです。作り直します。

- **作り直す:** `terraform apply -replace=aws_instance.this`。**DB・成果物は消えます**。必要なら先に `/var/lib/paw` のスナップショットを取る

その場で直す手順は用意していません。古い `paw-config-sync` と `/etc/paw-bootstrap/settings` が残り、実行のたびに設定が古い内容に戻って、サーバーモードの起動を拒むためです。

---

## 運用

| こと | コマンド（サーバーに入ってから） |
|---|---|
| アプリを最新にする | `sudo paw-update`（通信制限のスクリプトと `paw.service` も入れ直します） |
| 秘密情報を更新した後 | `sudo paw-config-sync && sudo systemctl restart paw` |
| ログを見る | `sudo journalctl -u paw -f` |
| 起動時の準備をやり直す | `sudo bash /var/lib/cloud/instance/user-data.txt` |

| こと | コマンド（手元の Mac） |
|---|---|
| 一時的に止める（EC2 の料金を下げる） | `aws ec2 stop-instances --region ap-northeast-1 --instance-ids <instance_id>`（止めている間は Issue に反応しません。ALB の料金は止まりません） |
| 再開 | `aws ec2 start-instances --region ap-northeast-1 --instance-ids <instance_id>` |
| 全部消す | `terraform destroy`（**DB・成果物も消えます**。SSM の秘密情報は残るので、不要なら `aws ssm delete-parameters` で消す） |

起動時スクリプトや AMI を変えても、Terraform は既存の EC2 を作り直しません（データを守るため）。作り直したいときは `terraform apply -replace=aws_instance.this` を使いますが、データは消えます。

## 費用の目安

主なものは次の 3 つです。

- ALB: 起動している間は常に課金される（EC2 を止めても止まらない）。月に数千円規模の見込み（概算。未確認）
- EC2（`t4g.medium`）と EBS（30GB）
- ALB の処理量（このアプリの通信量なら小さい見込み）

最新の金額は AWS の料金ページで確認してください。止めたいときは `terraform destroy` です。
