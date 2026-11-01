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
  default     = "/paw"

  validation {
    condition     = can(regex("^/[A-Za-z0-9_/-]+$", var.ssm_prefix)) && !endswith(var.ssm_prefix, "/")
    error_message = "ssm_prefix は /paw のように / で始め、末尾に / を付けないでください。"
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

variable "tailscale_hostname" {
  description = "Tailscale 上の名前。公開 URL は https://<この名前>.<tailnet名>.ts.net になる"
  type        = string
  default     = "paw"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.tailscale_hostname))
    error_message = "tailscale_hostname は英小文字・数字・- で指定してください。"
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
