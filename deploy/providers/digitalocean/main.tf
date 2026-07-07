terraform {
  required_version = ">= 1.6.0"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.50"
    }
  }
}

provider "digitalocean" {}

locals {
  preview_domain = var.preview_domain != "" ? var.preview_domain : "preview.${var.domain}"
  droplet_name   = "roomote-${var.customer_slug}"
  tags           = distinct(concat(["roomote", "roomote-self-host", "customer-${var.customer_slug}"], var.tags))

  app_record_raw               = var.dns_zone != "" ? trimsuffix(var.domain, ".${var.dns_zone}") : ""
  preview_record_raw           = var.dns_zone != "" ? trimsuffix(local.preview_domain, ".${var.dns_zone}") : ""
  app_record_name              = local.app_record_raw == "" ? "@" : local.app_record_raw
  preview_record_name          = local.preview_record_raw == "" ? "@" : local.preview_record_raw
  wildcard_preview_record_name = local.preview_record_name == "@" ? "*" : "*.${local.preview_record_name}"

  ssh_keys = var.ssh_key_fingerprint != "" ? [var.ssh_key_fingerprint] : [digitalocean_ssh_key.operator[0].fingerprint]
}

resource "digitalocean_ssh_key" "operator" {
  count      = var.ssh_key_fingerprint == "" ? 1 : 0
  name       = "${local.droplet_name}-operator"
  public_key = var.ssh_public_key
}

resource "digitalocean_volume" "roomote_data" {
  count                   = var.enable_volume ? 1 : 0
  region                  = var.region
  name                    = "${local.droplet_name}-data"
  size                    = var.volume_size_gb
  initial_filesystem_type = "ext4"
  description             = "Roomote data volume for ${var.customer_slug}"
}

resource "digitalocean_droplet" "roomote" {
  image      = var.droplet_image
  name       = local.droplet_name
  region     = var.region
  size       = var.droplet_size
  monitoring = true
  ipv6       = true
  ssh_keys   = local.ssh_keys
  tags       = local.tags
  volume_ids = var.enable_volume ? [digitalocean_volume.roomote_data[0].id] : []

  user_data = templatefile("${path.module}/cloud-init.yaml.tmpl", {
    customer_slug     = var.customer_slug
    roomote_version   = var.roomote_version
    image_registry    = var.image_registry
    image_namespace   = var.image_namespace
    enable_volume     = var.enable_volume
    volume_name       = var.enable_volume ? digitalocean_volume.roomote_data[0].name : ""
    volume_mount_path = var.volume_mount_path
  })
}

resource "digitalocean_firewall" "roomote" {
  name        = "${local.droplet_name}-firewall"
  droplet_ids = [digitalocean_droplet.roomote.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_cidrs
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

resource "digitalocean_record" "app" {
  count  = var.manage_dns ? 1 : 0
  domain = var.dns_zone
  type   = "A"
  name   = local.app_record_name
  value  = digitalocean_droplet.roomote.ipv4_address
  ttl    = var.dns_ttl
}

resource "digitalocean_record" "preview" {
  count  = var.manage_dns ? 1 : 0
  domain = var.dns_zone
  type   = "A"
  name   = local.preview_record_name
  value  = digitalocean_droplet.roomote.ipv4_address
  ttl    = var.dns_ttl
}

resource "digitalocean_record" "preview_wildcard" {
  count  = var.manage_dns ? 1 : 0
  domain = var.dns_zone
  type   = "A"
  name   = local.wildcard_preview_record_name
  value  = digitalocean_droplet.roomote.ipv4_address
  ttl    = var.dns_ttl
}
