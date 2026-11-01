output "instance_id" {
  description = "EC2 のインスタンス ID"
  value       = aws_instance.this.id
}

output "availability_zone" {
  value = local.az
}

output "connect" {
  description = "サーバーに入るコマンド（Session Manager。Mac に session-manager-plugin が必要）"
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.this.id}"
}

output "bootstrap_log" {
  description = "起動時の準備の進み具合を見るコマンド（サーバーに入ってから実行）"
  value       = "sudo tail -f /var/log/paw-bootstrap.log"
}

output "public_url" {
  description = "公開 URL を確認するコマンド（起動時の準備が Tailscale の接続まで進むと読める）"
  value       = "aws ssm get-parameter --region ${var.region} --name ${var.ssm_prefix}/public_url --query Parameter.Value --output text"
}
