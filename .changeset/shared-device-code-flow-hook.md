---
'@roomote/web': patch
---

Extract the OAuth device-code polling lifecycle shared by the ChatGPT, xAI, and GitHub Copilot connect dialogs into one `useDeviceCodeFlow` hook, leaving each dialog a thin presentational shell that supplies its provider-specific mutations, query invalidations, and copy. The three dialogs had drifted: each reimplemented the start-once guard, expiry deadline, slow-down backoff, and terminal states with small differences.

The hook combines the strongest behavior from each implementation. From the ChatGPT dialog: the client-side expiry deadline, distinct failure reasons driving dedicated copy, rate-limit backoff, and surfacing a rejected poll instead of leaving the promise unhandled. From the xAI dialog: monotonic generation-counter cancellation instead of a shared boolean, closing a race where cancelling and quickly reopening a dialog could revive a stale polling loop still holding the previous device code. The xAI and GitHub Copilot dialogs gain that race protection plus the polished terminal handling, and all three now hide the dead device code once a terminal error is shown instead of leaving it next to the error message.
