variable "region" {
  description = "AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "name" {
  description = "リソース名の接頭辞"
  type        = string
  default     = "paw"
}

variable "instance_type" {
  description = "EC2 のインスタンスタイプ（Claude Code の公式要件はメモリ 4GB 以上）"
  type        = string
  default     = "t4g.medium"
}

variable "architecture" {
  description = "AMI のアーキテクチャ。t4g など Graviton は arm64、t3 など Intel/AMD は amd64"
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "amd64"], var.architecture)
    error_message = "architecture は arm64 か amd64 を指定してください。"
  }
}

variable "root_volume_gb" {
  description = "ルートボリュームの容量（GB）。DB・成果物・リポジトリのクローンもここに置く"
  type        = number
  default     = 30
}

variable "vpc_cidr" {
  description = "専用 VPC の CIDR"
  type        = string
  default     = "10.80.0.0/16"
}

variable "ssm_prefix" {
  description = "秘密情報を置く SSM Parameter Store のパス（scripts/put-secrets.sh と同じ値）"
  type        = string
  default     = "/agents-office"

  validation {
    condition     = can(regex("^/[A-Za-z0-9_/-]+$", var.ssm_prefix)) && !endswith(var.ssm_prefix, "/")
    error_message = "ssm_prefix は /agents-office のように / で始め、末尾に / を付けないでください。"
  }
}

variable "github_app_id" {
  description = "GitHub App の App ID（General → About の数字。インストール画面の URL の数字ではない）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_app_id))
    error_message = "github_app_id は数字だけで指定してください。"
  }
}

variable "github_allowed_users" {
  description = "Issue からの起動・PR レビューを受け付ける GitHub ユーザー（カンマ区切り）"
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+(,[A-Za-z0-9-]+)*$", var.github_allowed_users))
    error_message = "github_allowed_users は Toshipy や alice,bob のように指定してください。"
  }
}

variable "app_repo_url" {
  description = "サーバーに取得するこのアプリのリポジトリ"
  type        = string
  default     = "https://github.com/Toshipy/agents-office.git"

  validation {
    condition     = can(regex("^https://[A-Za-z0-9./_-]+$", var.app_repo_url))
    error_message = "app_repo_url は https:// の URL で指定してください。"
  }
}

variable "app_repo_ref" {
  description = "取得するブランチ"
  type        = string
  default     = "claude/intelligent-keller-3gj7mv"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.app_repo_ref))
    error_message = "app_repo_ref はブランチ名で指定してください。"
  }
}

variable "allowed_cidrs" {
  description = "ALB の 443 番を開ける送信元 CIDR（社内 VPN の出口 IP。例: [\"203.0.113.1/32\"]）"
  type        = list(string)

  validation {
    condition     = length(var.allowed_cidrs) > 0 && alltrue([for c in var.allowed_cidrs : can(cidrnetmask(c))])
    error_message = "allowed_cidrs は 1 つ以上の IPv4 CIDR（例: 203.0.113.1/32）で指定してください。"
  }

  validation {
    condition     = !contains(var.allowed_cidrs, "0.0.0.0/0") && !contains(var.allowed_cidrs, "::/0")
    error_message = "allowed_cidrs に全世界（0.0.0.0/0）は指定できません。"
  }
}

variable "domain_name" {
  description = "公開するドメイン名"
  type        = string
  default     = "agents-office.c.fnrr.biz"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain_name))
    error_message = "domain_name は英小文字・数字・- と . のドメイン名で指定してください。"
  }
}

variable "dns_zone_name" {
  description = "DNS レコードを作る公開ゾーン（cloud-common アカウント）"
  type        = string
  default     = "c.fnrr.biz"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.dns_zone_name))
    error_message = "dns_zone_name は英小文字・数字・- と . のドメイン名で指定してください。"
  }
}

variable "dns_profile" {
  description = "cloud-common アカウントの AWS プロファイル名（DNS レコードを書くのに使う）"
  type        = string
  default     = "cloud-common"
}

variable "manage_dns" {
  description = "true なら DNS レコード（証明書の検証・ドメイン）を Terraform が作る。false なら作らず、出力の検証用 CNAME を手で登録する（2 段階の適用）"
  type        = bool
  default     = true
}

variable "allowed_email" {
  description = "ログインを許す Google アカウントのメールアドレス（1 人）"
  type        = string
  default     = "t.arai@fenrir.co.jp"

  validation {
    condition     = can(regex("^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$", var.allowed_email))
    error_message = "allowed_email はメールアドレスで指定してください（引用符や空白は使えません）。"
  }
}

variable "google_client_id_param" {
  description = "Google OAuth クライアント ID を入れた SSM パラメーター名。EC2 のロールが読めないよう ssm_prefix の外（-alb）に置く"
  type        = string
  default     = null
}

variable "google_client_secret_param" {
  description = "Google OAuth クライアント秘密を入れた SSM パラメーター名（SecureString）。EC2 のロールが読めないよう ssm_prefix の外（-alb）に置く"
  type        = string
  default     = null
}
