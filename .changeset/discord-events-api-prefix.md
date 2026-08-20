---
"@roomote/bullmq": patch
---

Fix Discord commands silently failing on self-hosted installs that serve the API under a path prefix. The queue worker built its `/api/internal/discord/events/process` URL with `new URL(path, base)`, which discards the prefix in the installer default `TRPC_URL` of `https://<domain>/_roomote-api`, so events were routed to the web app instead of the API and every command completed as a no-op. The endpoint is now appended to the configured base URL.
