variable "customer_slug" {
  description = "Stable lower-case deployment slug, for example matt-test."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.customer_slug))
    error_message = "customer_slug must be 3-63 characters and contain only lower-case letters, numbers, and hyphens."
  }
}

variable "region" {
  description = "DigitalOcean region slug."
  type        = string
  default     = "nyc3"
}

variable "droplet_size" {
  description = "DigitalOcean droplet size slug."
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "droplet_image" {
  description = "DigitalOcean image slug used for the VM."
  type        = string
  default     = "ubuntu-24-04-x64"
}

variable "domain" {
  description = "Primary Roomote app hostname."
  type        = string
}

variable "preview_domain" {
  description = "Preview proxy hostname. Defaults to domain for flat preview hostnames."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "Operator SSH public key. Required unless ssh_key_fingerprint is provided."
  type        = string
  default     = ""
  sensitive   = true
}

variable "ssh_key_fingerprint" {
  description = "Existing DigitalOcean SSH key fingerprint to attach instead of creating a key."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to SSH to the droplet."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "roomote_version" {
  description = "Immutable Roomote image tag to deploy, for example v0.1.0."
  type        = string
}

variable "image_registry" {
  description = "Container registry host."
  type        = string
  default     = "ghcr.io"
}

variable "image_namespace" {
  description = "Registry namespace containing roomote-* images."
  type        = string
  default     = "roocodeinc"
}

variable "manage_dns" {
  description = "Create DigitalOcean A records for domain, an optional separate preview_domain, and *.preview_domain."
  type        = bool
  default     = false
}

variable "dns_zone" {
  description = "DigitalOcean DNS zone, for example roomote.dev. Required when manage_dns is true."
  type        = string
  default     = ""
}

variable "dns_ttl" {
  description = "DNS record TTL in seconds."
  type        = number
  default     = 300
}

variable "enable_volume" {
  description = "Attach a separate optional DigitalOcean volume."
  type        = bool
  default     = false
}

variable "volume_size_gb" {
  description = "Optional volume size in GiB."
  type        = number
  default     = 50
}

variable "volume_mount_path" {
  description = "Mount path for the optional volume."
  type        = string
  default     = "/var/lib/docker"
}

variable "tags" {
  description = "Additional DigitalOcean tags."
  type        = list(string)
  default     = []
}
