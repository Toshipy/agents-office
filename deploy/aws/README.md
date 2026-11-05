# EC2 の中の通信制限の確認（Tester 用）

AWS への作成からアプリの起動までは、[terraform/README.md](terraform/README.md) だけを正とします。手作業で EC2 を作る手順は置いていません。

このファイルは、EC2 の中で Tester（AI が書いたテストを動かす Docker コンテナ）の通信制限が効いていることを確かめる手順だけを残しています。Terraform の起動時スクリプトが、次のスクリプトを `/usr/local/sbin/paw-test-network` に置き、`paw.service` が起動のたびに実行します。

## Tester 用の Docker ネットワークの通信制限を確認する（サーバー上）

Tester は、AI が書き換えたテストやスクリプトを動かします。秘密（`/etc/paw/paw.env`・GitHub App の秘密鍵）が見えないよう、作業コピーだけをマウントしたコンテナで動かし、そのコンテナからホストと内部ネットワークへ届かないようにします。依存の取得のためインターネットへは出られます。

制限は root で動くスクリプトで入れます。root で実行されるので、`/usr/local/sbin`（root 所有）に、root として置いたコピーを使います（`paw` が書ける `/home/paw` のスクリプトを直接は実行しません。更新は `sudo install` で置き直します）:

```bash
sudo install -o root -g root -m 755 /home/paw/agents-office/deploy/aws/paw-test-network.sh /usr/local/sbin/paw-test-network
```

```bash
sudo /usr/local/sbin/paw-test-network
```

`paw-test`（172.31.250.0/24）のネットワークができ、そこからの通信のうち、`10.0.0.0/8`・`172.16.0.0/12`・`192.168.0.0/16`・`169.254.0.0/16`（メタデータを含む）・`100.64.0.0/10`（CGNAT の範囲。害は無いので残している）への通信と、ホスト自身への通信が落とされます。ただし名前解決のため、上流の DNS リゾルバ（VPC のリゾルバなど）への 53 番だけは、落とす規則より先に許可します。

規則は iptables の **raw テーブル（PREROUTING）** の専用チェーン `PAW-TEST-A` / `PAW-TEST-B` にあります。Docker が filter テーブルの並びを入れ替えても、その前に評価されるので効きます。スクリプトは実行のたびに、使っていない方のチェーンを作り直して呼び出しを差し替え、古い方を消します（入れ直しの間も制限は途切れず、何度実行しても同じ状態になります）。確認:

```bash
sudo iptables -t raw -S
```

実機での確認（すべて Tester と同じ `paw-test` ネットワークのコンテナから。**初回の起動後と、再起動（`sudo reboot`）のあとにもう一度**行ってください）:

```bash
# 名前解決はできる（失敗するなら DNS の許可規則を確認）
sudo docker run --rm --network paw-test node:22-bookworm getent hosts registry.npmjs.org
# インターネットには出られる
sudo docker run --rm --network paw-test node:22-bookworm curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/
# メタデータ・ホストには届かない（どれもタイムアウトで失敗すれば OK）
sudo docker run --rm --network paw-test node:22-bookworm curl -sS -m 5 http://169.254.169.254/latest/meta-data/
sudo docker run --rm --network paw-test node:22-bookworm curl -sS -m 5 http://172.31.250.1:8787/
```

`docker` を再起動したあとも同じ結果になることを確認してください（規則は iptables の raw テーブルにあり、再起動では消えません。ネットワークを作り直したときは `sudo systemctl restart paw` で規則が入り直ります）。

Tester のイメージを先に取得しておきます:

```bash
sudo docker pull node:22-bookworm
```

### Docker の権限

`docker` グループに入れたユーザーは、ホストの root と同等の操作ができます（任意のパスをマウントしたコンテナを作れるため）。この構成は、`paw` ユーザー（API と Claude Code が動く）をこのグループに入れます。

- 採った理由: Tester を「コンテナに閉じ込めて、ホストの内部ネットワークへ出さない」には、ホスト側の iptables（raw テーブル）で縛れる通常の Docker が必要です。rootless Docker はネットワークがユーザー空間で動き、この規則が使えず、`169.254.169.254` などを落とす手段が弱くなるため採りませんでした。
- 残るリスク: `paw` として任意のコードが動けば、ホスト全体を奪えます。そのため、AI は `--restricted`（Bash などコードを動かすツールなし）で動かし、`docker` を呼ぶのはアプリだけ（引数はアプリが固定。作業コピーだけをマウント、`--cap-drop` 等で権限を落とす）にしています。EC2 自体も、受信は ALB のセキュリティグループからの 8787 番だけです。
- もっと強くしたいとき: Tester だけ別のホスト・別の VM に分ける（このリポジトリでは未対応）。

