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

output "alb_arn" {
  description = "ALB の ARN（アプリの PAW_ALB_ARN と同じ値）"
  value       = aws_lb.this.arn
}

output "alb_dns_name" {
  description = "ALB の DNS 名（manage_dns = false のとき、domain_name をこれへの CNAME として手で登録する）"
  value       = aws_lb.this.dns_name
}

output "certificate_validation_records" {
  description = "ACM の DNS 検証用レコード（manage_dns = false のとき、公開ゾーンへ手で登録する）"
  value = [
    for o in aws_acm_certificate.this.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "url" {
  description = "公開 URL（社内 VPN につないだ端末から開く）"
  value       = "https://${var.domain_name}"
}
