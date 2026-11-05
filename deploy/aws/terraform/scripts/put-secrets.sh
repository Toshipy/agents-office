#!/usr/bin/env bash
# 手元の Mac で実行する。秘密情報を SSM Parameter Store（SecureString）に登録する。
# 値は Terraform の state にも Git にも入らない。サーバーは起動時にここから読む。
#
#   AWS_REGION=ap-northeast-1 ./scripts/put-secrets.sh
#
# 自動で作る値（セッション鍵）は、既にあれば作り直さない。
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
PREFIX="${PAW_SSM_PREFIX:-/agents-office}"
# Google の OAuth クライアントは Terraform（ALB）だけが読む。EC2 のロールが読めないよう、$PREFIX/* の外に置く
ALB_PREFIX="${PAW_ALB_SSM_PREFIX:-${PREFIX}-alb}"

aws_ssm() { aws ssm "$@" --region "$REGION"; }

exists() { aws_ssm get-parameter --name "$PREFIX/$1" >/dev/null 2>&1; }

put_secure() {
  aws_ssm put-parameter --name "$PREFIX/$1" --type SecureString --overwrite --value "$2" >/dev/null
  echo "  ✓ $PREFIX/$1"
}

put_secure_alb() {
  aws_ssm put-parameter --name "$ALB_PREFIX/$1" --type SecureString --overwrite --value "$2" >/dev/null
  echo "  ✓ $ALB_PREFIX/$1"
}

show() { aws_ssm get-parameter --with-decryption --name "$PREFIX/$1" --query Parameter.Value --output text; }

echo "リージョン: $REGION / 保存先: $PREFIX/*（Google は $ALB_PREFIX/*）"
aws sts get-caller-identity --query Account --output text >/dev/null || {
  echo "AWS CLI の認証情報を確認してください（aws sts get-caller-identity）" >&2
  exit 1
}

echo
echo "1) Claude のサブスクのトークン（別のターミナルで 'claude setup-token' を実行して表示された値）"
read -rsp "   貼り付けて Enter（画面には表示されません）: " token
echo
[ -n "$token" ] || { echo "トークンが空です" >&2; exit 1; }
put_secure claude_code_oauth_token "$token"

echo
echo "2) GitHub App の秘密鍵（.pem）。サーバー用に新しく作ったもの"
read -rp "   ファイルのパス（例: ~/Downloads/xxx.private-key.pem）: " pem
pem="${pem/#\~/$HOME}"
[ -f "$pem" ] || { echo "ファイルが見つかりません: $pem" >&2; exit 1; }
grep -q "PRIVATE KEY" "$pem" || { echo "秘密鍵（PEM）ではないようです: $pem" >&2; exit 1; }
aws_ssm put-parameter --name "$PREFIX/github_app_private_key" --type SecureString --overwrite --value "file://$pem" >/dev/null
echo "  ✓ $PREFIX/github_app_private_key"

echo
echo "3) Google の OAuth クライアント（会社の Google Cloud で、内部の同意画面・ウェブアプリで作ったもの）"
read -rp "   クライアント ID: " gid
[ -n "$gid" ] || { echo "クライアント ID が空です" >&2; exit 1; }
read -rsp "   クライアント シークレット（画面には表示されません）: " gsecret
echo
[ -n "$gsecret" ] || { echo "シークレットが空です" >&2; exit 1; }
put_secure_alb google_client_id "$gid"
put_secure_alb google_client_secret "$gsecret"

echo
echo "4) 自動で作る値"
if exists session_secret; then echo "  - $PREFIX/session_secret は既にあるので変えません"; else put_secure session_secret "$(openssl rand -hex 32)"; fi
echo
echo "完了しました。次は terraform apply です（terraform/README.md）。"
