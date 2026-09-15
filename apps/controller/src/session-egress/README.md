# Session egress: controller-side admission

Coding runs attached to a Session receive owner-approved service credentials
as substitute tokens and use them through the API-side substitution proxy
(`apps/api/src/handlers/session-egress-proxy`). The real key never enters a
sandbox; the API injects it per request after re-checking live state. The
control-plane contract is in `apps/api/src/handlers/session-egress/CONTRACT.md`.

## Admission on every provider

1. `SessionEgressLifecycle.planApiProxy` preflights the run: a Session owner
   with Session secret tools enabled, at least one live grant, and a provider
   whose capability is `api_proxy`. Nothing is minted at this point.
2. The provider spawns the sandbox with the plan's bootstrap env
   (`ROOMOTE_SESSION_EGRESS_BOOTSTRAP_REQUIRED`, a per-attempt nonce) and
   ordinary connectivity but no substitutes. The worker runs repository
   checkout, tool installation, and environment setup, marks the nonce ready,
   and waits. Readiness is a transition request, never authority.
3. After the worker process is launched, `admitSessionEgressApiProxy` waits
   for the nonce, confirms the run is still active, registers (or rotates) the
   workload with the API, and publishes an encrypted, short-lived,
   nonce/run/generation-bound delivery: the proxy base URL, the nonsecret
   service manifest, and one `ROOMOTE_SERVICE_TOKEN_*` per grant. The API
   checks the signed run identity and live Session binding when the worker
   reads it. Lease renewal starts only after delivery.
4. Only then does the worker hand task processes the substitute-only client
   environment and start the model. Nothing about the sandbox's networking,
   trust store, or inference routing changes.

Docker, Modal, Roomote Cloud, Daytona, E2B, Blaxel, Box, and Azure all follow
this path. Docker is handed the API address its task network reaches
(`http://api:3001` on a control network, or the container-reachable API URL)
as the proxy base URL. A provider marked `unsupported` fails closed with a
nonsecret lifecycle event and receives nothing.

## Resume, failure, and cleanup

Resume repeats admission with a fresh nonce and rotates the workload
generation, so tokens restored with a snapshot or a retained container are
dead until re-delivery. A failed registration or delivery retires the
generation before the spawn fails; a failed spawn never leaves a worker that
expected substitutes without them. Normal run finalization (stop, completion,
failure, cancel, standby) terminates the workload, and the API refuses lease
renewals for runs that ended or were reattached, so an outage lets the lease
expire rather than failing open. Pending deliveries expire in 120 seconds and
stale or terminated generations cannot read them.

There is no deployment configuration: delivery is gated per Session owner by
the `session_secret_tools_enabled` experiment, the same gate as the Fast and
coding-run tools. An optional `R_SESSION_EGRESS_PROXY_HOST` serves the proxy
at the root of a dedicated hostname for SDK clients that accept only a host
override.
