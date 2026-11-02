#!/bin/bash
# Tester 用の Docker ネットワーク（paw-test）を作り、そこからホストと内部ネットワークへの通信を落とす。
# 何度実行しても同じ状態になる（ネットワークは無ければ作り、規則は無ければ足す）。
# root で実行する。paw.service の ExecStartPre=+ から、起動のたびに呼ぶ。
# 配置先: /usr/local/sbin/paw-test-network（root:root 0755。paw ユーザーが書き換えられない場所に置く）
set -euo pipefail

NET="${PAW_TEST_NETWORK:-paw-test}"
# 既定のアドレス帯は Docker の既定（172.17〜）と重ならないように選ぶ。既にネットワークがあればその値を使う
SUBNET_DEFAULT="${PAW_TEST_SUBNET:-172.31.250.0/24}"
BRIDGE="${PAW_TEST_BRIDGE:-paw-test0}"

# Docker が起動していなければ、規則を入れる先（DOCKER-USER）が無い
for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info >/dev/null 2>&1 || { echo "Docker に接続できません" >&2; exit 1; }

# 外部への到達が要るので、IPv6 は付けない（IPv6 側には規則を入れないため）
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$SUBNET_DEFAULT" \
    -o "com.docker.network.bridge.name=$BRIDGE" \
    -o "com.docker.network.bridge.enable_icc=false" \
    "$NET" >/dev/null
  echo "ネットワーク $NET を作りました（$SUBNET_DEFAULT）"
fi

SUBNET="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -n1)"
[ -n "$SUBNET" ] || { echo "ネットワーク $NET の IPv4 サブネットを取得できません" >&2; exit 1; }

# 規則が無いときだけ足す（-C で確認、無ければ -I で先頭に入れる。DOCKER-USER の末尾は RETURN なので、先頭でないと効かない）
ensure() {
  local chain="$1"; shift
  iptables -C "$chain" "$@" 2>/dev/null || iptables -I "$chain" "$@"
}

# コンテナから他へ転送される通信（FORWARD → DOCKER-USER）。
# 内部ネットワーク・リンクローカル（メタデータ 169.254.169.254 を含む）・tailnet への通信を落とす
for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  ensure DOCKER-USER -s "$SUBNET" -d "$dst" -j DROP
done

# ホスト自身が宛先の通信は FORWARD を通らず INPUT に来る。ブリッジのゲートウェイ・インスタンスのアドレス・
# Tailscale のアドレスを含め、このネットワークからホストへの入口はすべて落とす
# （コンテナの名前解決は Docker の組み込み DNS が行うので、INPUT を落としても影響しない）
ensure INPUT -s "$SUBNET" -j DROP

echo "paw-test-network: $NET（$SUBNET）の通信制限を確認しました"
