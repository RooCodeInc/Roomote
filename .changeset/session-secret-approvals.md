---
"roomote": minor
---

Add prototype Session secret approvals with a prepared-request flow. The agent prepares the service, exact public HTTPS origin and port, injection policy, and expiry. Session owners follow a direct link, enter only an API key in a secure form showing the service and exact HTTPS destination, and choose Allow for this Session. Header and prefix details are available only in separate approval management. Saving atomically approves the immutable owner-and-Session-bound request and automatically sends a nonsecret continuation message when available, without copying credentials or opaque references into chat. Approvals default to 24 hours, expire within 30 days, and can be revoked from the Session.

The form is excluded from capture and replay and clears credential inputs after submission or revocation. Public documentation explains request limits, safe disposable tests, and the trust boundary: an approved upstream receives the credential and may misuse its privileges or disclose transformed values, so this is not a universal secrecy guarantee.
