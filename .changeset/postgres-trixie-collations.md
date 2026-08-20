---
"@roomote/web": patch
---

Keep self-hosted PostgreSQL on the Trixie collation provider when enabling pgvector so existing databases do not report collation version mismatches after upgrading Roomote.
