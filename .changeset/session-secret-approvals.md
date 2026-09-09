---
"roomote": minor
---

Add prototype Session secret approvals with a prepared-request flow. The agent prepares the service, exact public HTTPS origin and port, injection policy, and expiry. Session owners follow a direct link, enter only an API key in a secure form showing the service and exact HTTPS destination, and choose Allow for this Session. Header and prefix details are available only in separate approval management. Saving atomically approves the immutable owner-and-Session-bound request and automatically sends a nonsecret continuation message when available, without copying credentials or opaque references into chat. Approvals default to 24 hours, expire within 30 days, and can be revoked from the Session.

The form is excluded from capture and replay and clears credential inputs after submission or revocation. Public documentation explains request limits, safe disposable tests, and the trust boundary: an approved upstream receives the credential and may misuse its privileges or disclose transformed values, so this is not a universal secrecy guarantee.

Fast and attached coding runs now use one API-owned HTTP transport for approved Session keys and operator integrations. Short-lived broker-only Fast authentication and persisted run attachments bind access to the live Session owner, never a caller-supplied Session ID. The broker rechecks ownership, attachment, revocation, and expiry before dispatch and before releasing the response. Session grants remain read-only on the exact approved HTTPS origin, normalize omitted/null/empty GET and HEAD bodies to no body, and enforce a 10-second deadline, 64 KiB response limit, guarded DNS, redirect refusal, and credential-echo suppression. Dynamic grants are read live independently of operator manifest reloads, without sending upstream keys to models or workers.

Session grants require no static manifest or per-service API credential environment variables. The broker remains available when operator mode is disabled; explicitly enabling operator mode still requires valid configuration and fails startup closed if it is missing or malformed. Existing deployment encryption and signing keys are reused.
