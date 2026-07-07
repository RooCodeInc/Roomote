output "customer_slug" {
  value = var.customer_slug
}

output "hostname" {
  value = var.domain
}

output "preview_hostname" {
  value = local.preview_domain
}

output "ipv4_address" {
  value = digitalocean_droplet.roomote.ipv4_address
}

output "ipv6_address" {
  value = digitalocean_droplet.roomote.ipv6_address
}

output "ssh_command" {
  value = "ssh root@${digitalocean_droplet.roomote.ipv4_address}"
}

output "url" {
  value = "https://${var.domain}"
}

output "preview_url" {
  value = "https://${local.preview_domain}"
}

output "droplet_id" {
  value = digitalocean_droplet.roomote.id
}

output "volume_id" {
  value = var.enable_volume ? digitalocean_volume.roomote_data[0].id : null
}
