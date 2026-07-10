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
capabilities, call them, and pay per use from the user's Zero wallet (Path C).
Roomote preinstalls the `zero` CLI in the agent runtime. Prefer that CLI for the
capability loop. The Zero MCP connector (`https://mcp.zero.xyz`) is for
authentication and funding when it is connected in Settings.

**When to use it:** as the fallback for anything genuinely beyond native
abilities — before telling the user "I can't do that," run `zero search`.
**When NOT to use it:** for things you already handle yourself — writing code,
answers from your own knowledge, local files, shell commands, math.

## Resolving `zero`

Roomote bakes the CLI into the worker runtime. Prefer bare `zero` on `$PATH`.
If it is missing, fall back to:

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

Path C: each user connects their own Zero wallet.

1. Prefer the Zero MCP connection when the deployment enabled Zero and the
   acting user linked their account from Settings. Use the connector to
   authorize a short-lived session when the skill requires it.
2. Human present: `zero auth login --start --json`, show the user the URL and
   code, then immediately run `zero auth login --finish <deviceCode> --json`.
3. Fully autonomous with no human: only then `zero auth agent register --json`,
   and later offer claim via `zero auth agent claim <email>` when a human should
   own the account.
4. Funding: point humans at https://www.zero.xyz/profile, or use
   `zero wallet fund --no-open` and relay the one-time URL.
5. Bring-your-own signing only when the user explicitly supplies
   `ZERO_PRIVATE_KEY`; never mint a key yourself.

## Gotchas

- Prefer the CLI loop even when MCP search/get/fetch tools also exist.
- Skip results with `bodySchema: null` rather than inventing fields.
- Raise `--timeout` for slow image/video/audio work.
- Review every paid call; use `zero runs --unreviewed` before ending multi-call tasks.
- Canonical upstream skill: https://zero.xyz/SKILL.md
