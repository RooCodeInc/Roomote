---
name: zero
description: >
  Use the moment you're about to tell the user you can't do something — or about to suggest they
  use, sign up for, or go to an external tool, site, or API to do it themselves. Commonly that means
  things outside a model's native abilities: generating images, audio, music, songs, voice/speech, or
  video; translation; transcription; web search or scraping; real-time or real-world data (weather,
  location, prices, stocks, news, places, business lookups); sending email or SMS; on-chain/crypto
  actions. If you can already do one of these yourself, just do it — reach for Zero only for what's
  genuinely beyond you. Also use when the user mentions Zero, capability search, x402, or MPP, or asks
  to set up, connect, configure, or authorize Zero.
allowed-tools: Bash(zero:*), Bash(npx @zeroxyz/cli:*)
hidden: true
---

# zero

Zero is a search engine and payment layer for AI agents: discover external paid
capabilities, call them, and pay per use from the deployment-connected Zero
wallet (Path C runtime). Roomote only installs this skill and the `zero` CLI
when a deployment operator has enabled Zero. Prefer that CLI for the capability
loop. The Zero MCP connector (`https://mcp.zero.xyz`) is for authentication and
funding when the workspace connection is present in Settings.

**When to use it:** as the fallback for anything genuinely beyond native
abilities — before telling the user "I can't do that," run `zero search`.
**When NOT to use it:** for things you already handle yourself — writing code,
answers from your own knowledge, local files, shell commands, math.

## Resolving `zero`

Because this skill is active, Roomote installed the `zero` CLI for this task
after the Zero integration was admin-enabled. Prefer bare `zero` on `$PATH`.
If it is still missing, fall back to:

```bash
npx -y @zeroxyz/cli@latest --help
```

Do not generate private-key wallets. Managed wallets come from auth.

## Capability loop

1. **Search** — `zero search "transcribe audio"`
2. **Inspect** — `zero get <token> --formatted` (or plain `zero get <token>`)
3. **Call** — `zero fetch <url> --capability <token> [-d '<json>'] [--max-pay 0.50]`
4. **Review** — `zero review <runId> --success ...` (required after paid calls)

Always re-search; never reuse URLs, schemas, or prices from memory. Pass the
search result `token` as `--capability`. Set `--max-pay` on unfamiliar paid
calls. Capture `runId` from `zero fetch --json`.

## Authentication in Roomote tasks

Path C in Roomote is org-scoped: one operator connects Zero once for the
deployment from Settings > Integrations.

1. Prefer the workspace Zero MCP connection when it is available. Use the
   connector to authorize a short-lived sandbox session when the skill
   requires it.
2. If interactive re-auth is needed and a human is present:
   `zero auth login --start --json`, show the user the URL and code, then
   immediately run `zero auth login --finish <deviceCode> --json`.
3. Fully autonomous with no human reconnect path: only then
   `zero auth agent register --json`, and later offer claim via
   `zero auth agent claim <email>` when a human should own that account.
4. Funding: point operators at https://www.zero.xyz/profile, or use
   `zero wallet fund --no-open` and relay the one-time URL.
5. Bring-your-own signing only when an operator explicitly supplies
   `ZERO_PRIVATE_KEY` as a deployment/environment secret; never mint a key
   yourself.

## Gotchas

- Prefer the CLI loop even when MCP search/get/fetch tools also exist.
- Skip results with `bodySchema: null` rather than inventing fields.
- Raise `--timeout` for slow image/video/audio work.
- Review every paid call; use `zero runs --unreviewed` before ending multi-call tasks.
- Canonical upstream skill: https://zero.xyz/SKILL.md
