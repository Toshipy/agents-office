#!/bin/bash
# Tester 用の Docker ネットワーク（paw-test）を作り、そこからホストと内部ネットワークへの通信を落とす。
# 何度実行しても同じ状態になる（ネットワークは無ければ作り、規則は専用チェーンを作り直す）。
# root で実行する。paw.service の ExecStartPre=+ から、起動のたびに呼ぶ。
# 配置先: /usr/local/sbin/paw-test-network（root:root 0755。bootstrap と paw-update が root として配置する）
set -euo pipefail

# paw.service の PATH（/home/paw/.local/bin 先頭）を引き継がない。root 実行なので、paw が書ける場所は使わない
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

NET="${PAW_TEST_NETWORK:-paw-test}"
# 既定のアドレス帯は Docker の既定（172.17〜）と重ならないように選ぶ。既にネットワークがあればその値を使う
SUBNET_DEFAULT="${PAW_TEST_SUBNET:-172.31.250.0/24}"
BRIDGE_DEFAULT="${PAW_TEST_BRIDGE:-paw-test0}"
CHAIN=PAW-TEST

# Docker が起動していなければネットワークを作れない
for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info >/dev/null 2>&1 || { echo "Docker に接続できません" >&2; exit 1; }

# IPv6 は付けない（規則は IPv4 だけ）
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet "$SUBNET_DEFAULT" \
    -o "com.docker.network.bridge.name=$BRIDGE_DEFAULT" \
    -o "com.docker.network.bridge.enable_icc=false" \
    "$NET" >/dev/null
  echo "ネットワーク $NET を作りました（$SUBNET_DEFAULT）"
fi

SUBNET="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -n1 || true)"
[ -n "$SUBNET" ] || { echo "ネットワーク $NET の IPv4 サブネットを取得できません" >&2; exit 1; }

# ブリッジのインターフェース名（作成時に指定した名前。無ければ Docker の既定の br-<ID 先頭 12 文字>）
BRIDGE="$(docker network inspect "$NET" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null || true)"
if [ -z "$BRIDGE" ]; then
  BRIDGE="br-$(docker network inspect "$NET" --format '{{.Id}}' | cut -c1-12)"
fi
ip link show "$BRIDGE" >/dev/null 2>&1 || { echo "ブリッジ $BRIDGE が見つかりません" >&2; exit 1; }

# 規則は raw テーブルの PREROUTING に置く。filter の FORWARD/INPUT（Docker・Tailscale・ufw が順序を入れ替える）より前で
# 評価されるので、他のサービスの再起動や規則の並びに左右されない。
# 専用チェーン PAW-TEST を毎回作り直し、PREROUTING からの呼び出しが無ければ足す（再実行しても同じ状態になる）
iptables -t raw -N "$CHAIN" 2>/dev/null || true
iptables -t raw -F "$CHAIN"

# 1) 名前解決: Docker の組み込み DNS は、コンテナの名前空間から上流のリゾルバへ問い合わせる。
#    上流リゾルバ（VPC リゾルバなど。127.x のスタブは除く）への 53 番だけを許可する（DROP より先に評価される）
resolvers="$(awk '/^nameserver[[:space:]]/ {print $2}' /run/systemd/resolve/resolv.conf /etc/resolv.conf 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | sort -u || true)"
if [ -z "$resolvers" ]; then
  echo "警告: 上流の DNS リゾルバが見つかりません。コンテナの名前解決は失敗します" >&2
fi
for ns in $resolvers; do
  iptables -t raw -A "$CHAIN" -p udp -d "$ns" --dport 53 -j ACCEPT
  iptables -t raw -A "$CHAIN" -p tcp -d "$ns" --dport 53 -j ACCEPT
done

# 2) 内部ネットワーク・リンクローカル（メタデータ 169.254.169.254 を含む）・tailnet への通信を落とす
for dst in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  iptables -t raw -A "$CHAIN" -d "$dst" -j DROP
done

# 3) ホスト自身のアドレス宛て（ゲートウェイ・インスタンスのアドレス・Tailscale のアドレスを含む）を落とす
iptables -t raw -A "$CHAIN" -m addrtype --dst-type LOCAL -j DROP

# このネットワークのブリッジから入ってきた通信だけを PAW-TEST で評価する
iptables -t raw -C PREROUTING -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || iptables -t raw -I PREROUTING 1 -i "$BRIDGE" -j "$CHAIN"

echo "paw-test-network: $NET（$SUBNET、$BRIDGE）の通信制限を確認しました（DNS: ${resolvers:-なし}）"
