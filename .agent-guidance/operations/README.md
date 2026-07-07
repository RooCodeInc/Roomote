---
title: Operations Runbook Index
status: active
last_reviewed: 2026-06-29
owner: engineering
summary: Index of operational docs covering local deployment, V1 production deploys, self-host operator guidance, monitoring, request observability, dev tooling, and testing.
---

# Operations

- [Self-Hosting Operator Guide](../../SELF_HOSTING.md) — Public-facing single-host install and operations guide for local self-host Compose and the production Caddy overlay
- [Deployment & Release](./deployment.md) — Local-first deployment and release process covering Docker Compose, PM2 services, V1 GHCR/DigitalOcean production deploys, worker archive builds, and CI
- [Monitoring & Health Checks](./monitoring.md) — Health monitoring covering API endpoints, slow-request logging, outbound timeouts, controller heartbeat, orphan detection, and debugging patterns
- [Dev CLI](./dev-cli.md) — Local development CLI covering database seeding, local seeding, and GitHub bootstrap
- [Testing Strategy](./testing.md) — Prioritizing high-signal tests, choosing the right test layer, and running Roomote validation paths
