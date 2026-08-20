---
"@roomote/bullmq": patch
---

Fix Discord commands silently failing on self-hosted installs that serve the API under a path prefix. The queue worker built its `/api/internal/discord/events/process` URL with `new URL(path, base)`, which discards the prefix in the installer default `TRPC_URL` of `https://<domain>/_roomote-api`, so events were routed to the web app instead of the API. The endpoint is now appended to the configured base URL, and the worker requires the API's JSON acknowledgement before marking a job complete, so a misrouted request fails visibly rather than passing as success.
