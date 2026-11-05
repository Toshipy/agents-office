# ---- EC2 の初回起動時に root で 1 回だけ実行される（cloud-init の user-data）----
# 先頭の export（Terraform が付ける）で PAW_REGION などの設定を受け取る。
# 秘密情報は SSM Parameter Store（${PAW_SSM_PREFIX}/...）から読む。進み具合は /var/log/paw-bootstrap.log。
set -euo pipefail
exec > >(tee -a /var/log/paw-bootstrap.log) 2>&1
log() { echo "[paw $(date '+%H:%M:%S')] $*"; }
log "起動時の準備を開始します"

export DEBIAN_FRONTEND=noninteractive
install -d -o root -g root -m 755 /etc/paw-bootstrap

# 後から設定を読み直すスクリプト（paw-config-sync）でも使う設定
cat > /etc/paw-bootstrap/settings <<EOF
PAW_REGION='${PAW_REGION}'
PAW_SSM_PREFIX='${PAW_SSM_PREFIX}'
PAW_GITHUB_APP_ID='${PAW_GITHUB_APP_ID}'
PAW_GITHUB_ALLOWED_USERS='${PAW_GITHUB_ALLOWED_USERS}'
PAW_DOMAIN='${PAW_DOMAIN}'
PAW_ALB_ARN='${PAW_ALB_ARN}'
PAW_ALLOWED_EMAIL='${PAW_ALLOWED_EMAIL}'
PAW_CLAUDE_CODE_RESTRICTED='1'
EOF
chmod 644 /etc/paw-bootstrap/settings

# ---- パッケージ ----
log "パッケージを入れます"
apt-get update -y
apt-get install -y git curl ca-certificates jq unzip openssl iptables

# Docker（Tester のコンテナ用）。Ubuntu 標準の docker.io を使う
if ! command -v docker >/dev/null 2>&1; then
  log "Docker を入れます"
  apt-get install -y docker.io
fi
systemctl enable --now docker

if ! command -v aws >/dev/null 2>&1; then
  log "AWS CLI v2 を入れます"
  arch="$(uname -m)" # aarch64 / x86_64
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o /tmp/awscliv2.zip
  rm -rf /tmp/aws && unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi

if ! command -v node >/dev/null 2>&1; then
  log "Node.js 22 を入れます（NodeSource）"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi
corepack enable

# ---- アプリ用のユーザーと置き場所 ----
id paw >/dev/null 2>&1 || useradd -m -s /bin/bash paw
# paw は Tester のコンテナを起動するため docker グループに入れる。
# docker グループはホストの root と同等の権限になる（README の「Docker の権限」を参照）
usermod -aG docker paw
install -d -o paw -g paw -m 700 /var/lib/paw
install -d -o root -g paw -m 750 /etc/paw

# ---- Claude Code とアプリ（paw ユーザー） ----
log "Claude Code を入れます"
sudo -H -u paw bash -lc 'curl -fsSL https://claude.ai/install.sh | bash'

log "アプリを取得してビルドします（${PAW_REPO_REF}）"
if [ ! -d /home/paw/agents-office/.git ]; then
  sudo -H -u paw git clone --branch "${PAW_REPO_REF}" "${PAW_REPO_URL}" /home/paw/agents-office
fi
sudo -H -u paw bash -lc 'cd ~/agents-office && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile && pnpm --filter @paw/web build'

# ---- 秘密情報と設定から設定ファイルを作るスクリプト（後から再実行できる） ----
cat > /usr/local/bin/paw-config-sync <<'SYNC'
#!/bin/bash
# SSM Parameter Store の値と Terraform が渡した設定から /etc/paw/paw.env と GitHub App の秘密鍵を作り直す。
# 秘密情報を更新したら: sudo paw-config-sync && sudo systemctl restart paw
set -euo pipefail
. /etc/paw-bootstrap/settings
get() {
  aws ssm get-parameter --region "$PAW_REGION" --with-decryption --name "$PAW_SSM_PREFIX/$1" --query Parameter.Value --output text
}
umask 077
get github_app_private_key > /etc/paw/github-app.pem.new
chown root:paw /etc/paw/github-app.pem.new && chmod 640 /etc/paw/github-app.pem.new
mv /etc/paw/github-app.pem.new /etc/paw/github-app.pem

public_url="https://${PAW_DOMAIN}"

cat > /etc/paw/paw.env.new <<ENV
PAW_PUBLIC_URL=${public_url}
PAW_AUTH=alb_oidc
PAW_ALB_ARN=${PAW_ALB_ARN}
PAW_ALLOWED_EMAIL=${PAW_ALLOWED_EMAIL}
PAW_API_HOST=0.0.0.0
PAW_AWS_REGION=${PAW_REGION}
PAW_SEED_DEMO=0
PAW_DEV_ROUTES=0
PAW_DATA_DIR=/var/lib/paw
PAW_SESSION_SECRET=$(get session_secret)
PAW_AGENT_RUNTIME=claude-code
CLAUDE_CODE_OAUTH_TOKEN=$(get claude_code_oauth_token)
PAW_CLAUDE_STEP_TIMEOUT_MS=1800000
PAW_CLAUDE_CODE_RESTRICTED=${PAW_CLAUDE_CODE_RESTRICTED}
PAW_GITHUB_APP_ID=${PAW_GITHUB_APP_ID}
PAW_GITHUB_APP_PRIVATE_KEY_FILE=/etc/paw/github-app.pem
PAW_GITHUB_ALLOWED_USERS=${PAW_GITHUB_ALLOWED_USERS}
PAW_GITHUB_LOGIN=${PAW_GITHUB_ALLOWED_USERS%%,*}
PAW_GITHUB_POLL_MS=900000
PAW_TEST_SANDBOX=docker
PAW_TEST_IMAGE=node:22-bookworm
PAW_TEST_NETWORK=paw-test
ENV
chown root:paw /etc/paw/paw.env.new && chmod 640 /etc/paw/paw.env.new
mv /etc/paw/paw.env.new /etc/paw/paw.env

echo "設定を更新しました（公開 URL: ${public_url}）"
SYNC
chmod 755 /usr/local/bin/paw-config-sync

# Tester 用ネットワークと通信制限のスクリプト。root で実行されるため、paw が直接書ける場所からではなく、
# root 所有の場所（/usr/local/sbin）へ、bootstrap と paw-update が root としてコピーしたものを使う
install_test_network() {
  install -o root -g root -m 755 /home/paw/agents-office/deploy/aws/paw-test-network.sh /usr/local/sbin/paw-test-network
}
declare -f install_test_network > /etc/paw-bootstrap/functions.sh

# アプリの更新用
cat > /usr/local/bin/paw-update <<'UPDATE'
#!/bin/bash
# GitHub から最新を取得してビルドし直し、再起動する
set -euo pipefail
sudo -H -u paw bash -lc 'cd ~/agents-office && git pull --ff-only && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile && pnpm --filter @paw/web build'
. /etc/paw-bootstrap/functions.sh
install_test_network
cp /home/paw/agents-office/deploy/aws/paw.service /etc/systemd/system/paw.service
systemctl daemon-reload
systemctl restart paw
echo "更新して再起動しました"
UPDATE
chmod 755 /usr/local/bin/paw-update

# ---- Tester 用の Docker ネットワークと通信制限 ----
log "Tester 用の Docker ネットワークを作ります"
. /etc/paw-bootstrap/functions.sh
install_test_network
/usr/local/sbin/paw-test-network
log "Tester のイメージを取得します（node:22-bookworm）"
docker pull node:22-bookworm || log "イメージを取得できませんでした。初回の Tester 実行時に取得します"

# ---- 設定ファイル ----
log "SSM Parameter Store から設定ファイルを作ります"
/usr/local/bin/paw-config-sync

# ---- Claude Code の動作確認（制限モードで動くなら有効にする） ----
# 成否は終了コードで判定する（claude -p は失敗時に 0 以外で終わる）。出力は記録用
check_claude() {
  sudo -H -u paw bash -c "set -a; . /etc/paw/paw.env; set +a; cd /tmp && timeout 180 ~/.local/bin/claude -p 'ok とだけ返して' $1"
}
if out="$(check_claude '' 2>&1)"; then
  log "Claude Code の確認（通常）: 成功 — ${out:0:120}"
else
  log "Claude Code の確認（通常）: 失敗 — ${out: -300}"
  log "サブスクのトークン（${PAW_SSM_PREFIX}/claude_code_oauth_token）を確認してください。直すまで Claude の工程は失敗します"
fi
# サーバーモードは --restricted が必須（0 にはしない）。試行が失敗しても 1 のままにし、原因を直すよう促す
if out="$(check_claude '--restricted' 2>&1)"; then
  log "制限モード（--restricted）の確認: 成功"
else
  log "制限モード（--restricted）の確認: 失敗 — ${out: -200}"
  log "サーバーモードは --restricted が必須のため、無効にはしません。トークン（${PAW_SSM_PREFIX}/claude_code_oauth_token）や Claude Code を直してから sudo paw-config-sync && sudo systemctl restart paw を実行してください"
fi

# ---- 常時起動 ----
log "アプリを起動します"
cp /home/paw/agents-office/deploy/aws/paw.service /etc/systemd/system/paw.service
systemctl daemon-reload
systemctl enable --now paw

log "起動時の準備が終わりました。公開 URL: https://${PAW_DOMAIN}"
