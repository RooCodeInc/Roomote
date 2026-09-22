---
'@roomote/web': minor
---

Add a `browse` tool to Fast Sessions that gives each conversation a private cloud browser without a sandbox. Configure `R_FAST_BROWSER_PROVIDER=browseruse` with `R_BROWSER_USE_API_KEY`, or `R_FAST_BROWSER_PROVIDER=cdp` with `R_FAST_BROWSER_CDP_URL` pointing at a self-hosted browser such as the new optional `browserless` Compose service (`--profile browser`), to enable it. Screenshots and recordings are saved as Session artifacts, shown in the web transcript, and attached to chat replies when the agent asks for delivery.
