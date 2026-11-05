terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "personal-ai-workspace"
      ManagedBy = "terraform"
    }
  }
}

# cloud-common アカウントの公開ゾーン（c.fnrr.biz）に DNS レコードを書くためのプロバイダー。
# manage_dns = false のときは使わない（このプロバイダーを使うリソースを作らない）
provider "aws" {
  alias   = "dns"
  region  = var.region
  profile = var.manage_dns ? var.dns_profile : null
}
