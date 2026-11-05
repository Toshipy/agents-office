# Personal AI Workspace を EC2 1 台で常時動かす構成。
#  - 専用 VPC のパブリックサブネットに置く。EC2 の受信は ALB のセキュリティグループからの 8787 番だけ
#  - 公開は ALB（443 番）。受信は allowed_cidrs（社内 VPN の出口 IP）だけ、ログインは Google の OIDC（ALB 標準）
#  - 証明書は ACM（DNS 検証）。DNS レコードは cloud-common アカウントの公開ゾーンに置く
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

# ALB 用の 2 つ目のアベイラビリティゾーン（ALB は 2 つ以上の AZ が要る）
data "aws_availability_zones" "available" {
  state = "available"
}

# Google の OAuth クライアント（Terraform が読み、ALB のリスナーに渡す。EC2 のロールからは読めない場所に置く）
data "aws_ssm_parameter" "google_client_id" {
  name            = local.google_client_id_param
  with_decryption = true
}

data "aws_ssm_parameter" "google_client_secret" {
  name            = local.google_client_secret_param
  with_decryption = true
}

locals {
  az                         = sort(data.aws_ec2_instance_type_offerings.available.locations)[0]
  az_alb                     = [for z in sort(data.aws_availability_zones.available.names) : z if z != local.az][0]
  google_client_id_param     = coalesce(var.google_client_id_param, "${var.ssm_prefix}-alb/google_client_id")
  google_client_secret_param = coalesce(var.google_client_secret_param, "${var.ssm_prefix}-alb/google_client_secret")
  ssm_param_arn              = "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.ssm_prefix}"
  bootstrap_vars             = <<-EOT
    #!/bin/bash
    # ---- Terraform から渡す設定（秘密情報は含めない） ----
    export PAW_REGION='${var.region}'
    export PAW_SSM_PREFIX='${var.ssm_prefix}'
    export PAW_GITHUB_APP_ID='${var.github_app_id}'
    export PAW_GITHUB_ALLOWED_USERS='${var.github_allowed_users}'
    export PAW_DOMAIN='${var.domain_name}'
    export PAW_ALB_ARN='${aws_lb.this.arn}'
    export PAW_ALLOWED_EMAIL='${var.allowed_email}'
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
  map_public_ip_on_launch = true # 外向きの通信（GitHub・Claude・SSM）に使う。受信は ALB のセキュリティグループからだけ

  tags = { Name = "${var.name}-public" }
}

# ALB 用の 2 つ目のパブリックサブネット（EC2 とは別の AZ）
resource "aws_subnet" "public_alb" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 2)
  availability_zone = local.az_alb

  tags = { Name = "${var.name}-public-alb" }
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

resource "aws_route_table_association" "public_alb" {
  subnet_id      = aws_subnet.public_alb.id
  route_table_id = aws_route_table.public.id
}

# ALB と EC2 のセキュリティグループは互いを参照するため、ルールは別リソースで書く（循環を避ける）
resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "ALB. Inbound 443 only from allowed CIDRs (corporate VPN egress)."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-alb" }
}

resource "aws_security_group" "instance" {
  name        = "${var.name}-instance"
  description = "Inbound 8787 only from the ALB. Outbound only (GitHub, Claude, SSM)."
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-instance" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.allowed_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from allowed CIDR"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "alb_to_instance" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the instance app port"
  ip_protocol                  = "tcp"
  from_port                    = 8787
  to_port                      = 8787
  referenced_security_group_id = aws_security_group.instance.id
}

# authenticate-oidc では、ALB 自身が Google のトークン・userinfo エンドポイント（443 番）へ出る必要がある。
# これを塞ぐと、ログイン後に ALB が 500 を返す
resource "aws_vpc_security_group_egress_rule" "alb_to_idp" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS to the OIDC IdP (Google) for authenticate-oidc"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "instance_from_alb" {
  security_group_id            = aws_security_group.instance.id
  description                  = "App port from the ALB"
  ip_protocol                  = "tcp"
  from_port                    = 8787
  to_port                      = 8787
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "instance_all" {
  security_group_id = aws_security_group.instance.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---- IAM（Session Manager と、${ssm_prefix}/* の秘密情報の読み取りだけ） ----

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
    sid       = "ReadAppParameters"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["${local.ssm_param_arn}/*"]
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

# ---- ALB・証明書・DNS ----

resource "aws_lb" "this" {
  name                       = "${var.name}-alb"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [aws_subnet.public.id, aws_subnet.public_alb.id]
  idle_timeout               = 300 # SSE を途切れさせない
  drop_invalid_header_fields = true

  tags = { Name = "${var.name}-alb" }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_lb_target_group" "app" {
  name     = "${var.name}-app"
  port     = 8787
  protocol = "HTTP"
  vpc_id   = aws_vpc.this.id

  health_check {
    path    = "/v1/health"
    matcher = "200"
  }

  tags = { Name = "${var.name}-app" }
}

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.this.id
  port             = 8787
}

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = var.name }
}

data "aws_route53_zone" "this" {
  count    = var.manage_dns ? 1 : 0
  provider = aws.dns

  name         = var.dns_zone_name
  private_zone = false
}

resource "aws_route53_record" "validation" {
  for_each = var.manage_dns ? {
    for o in aws_acm_certificate.this.domain_validation_options : o.domain_name => o
  } : {}
  provider = aws.dns

  zone_id         = data.aws_route53_zone.this[0].zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  count = var.manage_dns ? 1 : 0

  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.validation : r.fqdn]
}

resource "aws_route53_record" "app" {
  count    = var.manage_dns ? 1 : 0
  provider = aws.dns

  zone_id = data.aws_route53_zone.this[0].zone_id
  name    = var.domain_name
  type    = "CNAME"
  records = [aws_lb.this.dns_name]
  ttl     = 300
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  # manage_dns = false のときは、証明書が発行済み（手で CNAME を登録済み）になるまでこのリソースは作れない
  certificate_arn = var.manage_dns ? aws_acm_certificate_validation.this[0].certificate_arn : aws_acm_certificate.this.arn

  default_action {
    type  = "authenticate-oidc"
    order = 1

    authenticate_oidc {
      issuer                     = "https://accounts.google.com"
      authorization_endpoint     = "https://accounts.google.com/o/oauth2/v2/auth"
      token_endpoint             = "https://oauth2.googleapis.com/token"
      user_info_endpoint         = "https://openidconnect.googleapis.com/v1/userinfo"
      client_id                  = data.aws_ssm_parameter.google_client_id.value
      client_secret              = data.aws_ssm_parameter.google_client_secret.value
      scope                      = "openid email profile"
      session_timeout            = 604800
      on_unauthenticated_request = "authenticate"
    }
  }

  default_action {
    type             = "forward"
    order            = 2
    target_group_arn = aws_lb_target_group.app.arn
  }
}
