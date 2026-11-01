# Personal AI Workspace を EC2 1 台で常時動かす構成。
#  - 専用 VPC のパブリックサブネットに置くが、セキュリティグループで受信はすべて拒否（外向きの通信のみ）
#  - 公開の入口は Tailscale Funnel（EC2 から Tailscale へ外向きに接続し、HTTPS を受ける）
#  - サーバーには SSM Session Manager で入る（SSH の鍵もポートも不要）
#  - 秘密情報は SSM Parameter Store（SecureString）に置き、起動時に読む。Terraform の state には入れない

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# Canonical 公式の Ubuntu 24.04 LTS
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${var.architecture}-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# 指定のインスタンスタイプを使えるアベイラビリティゾーン
data "aws_ec2_instance_type_offerings" "available" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

locals {
  az              = sort(data.aws_ec2_instance_type_offerings.available.locations)[0]
  ssm_param_arn   = "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_prefix}"
  bootstrap_vars  = <<-EOT
    #!/bin/bash
    # ---- Terraform から渡す設定（秘密情報は含めない） ----
    export PAW_REGION='${var.region}'
    export PAW_SSM_PREFIX='${var.ssm_prefix}'
    export PAW_GITHUB_APP_ID='${var.github_app_id}'
    export PAW_GITHUB_ALLOWED_USERS='${var.github_allowed_users}'
    export PAW_TS_HOSTNAME='${var.tailscale_hostname}'
    export PAW_REPO_URL='${var.app_repo_url}'
    export PAW_REPO_REF='${var.app_repo_ref}'
  EOT
}

# ---- ネットワーク ----

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  availability_zone       = local.az
  map_public_ip_on_launch = true # 外向きの通信（GitHub・Claude・Tailscale・SSM）に使う。受信はセキュリティグループで拒否

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "instance" {
  name        = "${var.name}-instance"
  description = "No inbound. Outbound only (GitHub, Claude, Tailscale, SSM)."
  vpc_id      = aws_vpc.this.id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name}-instance" }
}

# ---- IAM（Session Manager と、/paw/* の秘密情報の読み取りだけ） ----

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "secrets" {
  statement {
    sid       = "ReadPawParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["${local.ssm_param_arn}/*"]
  }

  # 公開 URL（Tailscale の名前から決まる）を書き戻し、手元の Mac から読めるようにする
  statement {
    sid       = "WritePublicUrl"
    actions   = ["ssm:PutParameter"]
    resources = ["${local.ssm_param_arn}/public_url"]
  }

  # SecureString の復号（AWS 管理キー aws/ssm を SSM 経由で使う場合だけ）
  statement {
    sid       = "DecryptViaSsm"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "secrets" {
  name   = "${var.name}-secrets"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.secrets.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

# ---- EC2 ----

resource "aws_instance" "this" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  user_data = "${local.bootstrap_vars}\n${file("${path.module}/scripts/bootstrap.sh")}"

  metadata_options {
    http_tokens                 = "required" # IMDSv2 のみ
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  tags = { Name = var.name }

  lifecycle {
    # 新しい AMI が出たり起動スクリプトを直したりしても、勝手に作り直さない（DB と作業データがこのディスクにあるため）
    ignore_changes = [ami, user_data]
  }

  depends_on = [aws_route_table_association.public, aws_iam_role_policy.secrets]
}
