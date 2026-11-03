#!/usr/bin/env bash
# 手元の Mac で実行する。秘密情報を SSM Parameter Store（SecureString）に登録する。
# 値は Terraform の state にも Git にも入らない。サーバーは起動時にここから読む。
#
#   AWS_REGION=ap-northeast-1 ./scripts/put-secrets.sh
#
# 自動で作る値（セッション鍵・登録コード）は、既にあれば作り直さない。
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
PREFIX="${PAW_SSM_PREFIX:-/paw}"

aws_ssm() { aws ssm "$@" --region "$REGION"; }

exists() { aws_ssm get-parameter --name "$PREFIX/$1" >/dev/null 2>&1; }

put_secure() {
  aws_ssm put-parameter --name "$PREFIX/$1" --type SecureString --overwrite --value "$2" >/dev/null
  echo "  ✓ $PREFIX/$1"
}

show() { aws_ssm get-parameter --with-decryption --name "$PREFIX/$1" --query Parameter.Value --output text; }

echo "リージョン: $REGION / 保存先: $PREFIX/*"
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
echo "3) Tailscale の認証キー（管理画面の Settings → Keys → Generate auth key で作った tskey-auth-... の値）"
read -rsp "   貼り付けて Enter（画面には表示されません）: " tskey
echo
[ -n "$tskey" ] || { echo "認証キーが空です" >&2; exit 1; }
put_secure tailscale_auth_key "$tskey"

echo
echo "4) 自動で作る値"
if exists session_secret; then echo "  - $PREFIX/session_secret は既にあるので変えません"; else put_secure session_secret "$(openssl rand -hex 32)"; fi
if exists signup_code; then echo "  - $PREFIX/signup_code は既にあるので変えません"; else put_secure signup_code "$(openssl rand -hex 16)"; fi

echo
echo "------------------------------------------------------------"
echo "最初の新規登録で入力する登録コード:"
echo "  $(show signup_code)"
echo "------------------------------------------------------------"
echo "（あとで確認するとき: aws ssm get-parameter --region $REGION --with-decryption --name $PREFIX/signup_code --query Parameter.Value --output text）"
