# Credential egress control plane and proxy: controller -> API contract

Base path: `/api/internal/credential-egress` (constant
`CREDENTIAL_EGRESS_CONTROL_PLANE_PATH` in `@roomote/types`). All bodies are JSON.
Schemas and response types live in `packages/types/src/credential-egress.ts`;
persistence in `packages/db/src/lib/credential-egress.ts`; the service layer and a
typed controller client in `packages/sdk/src/server/lib/credential-egress.ts`;
the substitution proxy in `apps/api/src/handlers/credential-egress-proxy`.

## Threat model in one paragraph

Workloads (attached coding runs) receive only opaque **substitute tokens**
(`rses_` + 32 random bytes, base64url) and one proxy base URL. The real
credential exists only encrypted at rest and, per request, in API memory while
the proxy forwards to the approved origin. Nothing a sandbox can send is
authority: not a Session ID, not a header, not a path. Possession of a
substitute names a grant, and every use is bounded by the workload
registration the trusted controller created, the workload generation the
substitute was minted in, the lease, and the live owner/Session/attached-run/
grant state re-joined on every call.

## Principals and authentication

One service principal exists. The controller authenticates with
`Authorization: Bearer <ES256 JWT>` minted by
`createCredentialEgressControllerToken()` (`@roomote/auth`) with the deployment
`JOB_AUTH_PRIVATE_KEY`; `aud=roomote-credential-egress-controller`,
`sub=roomote-controller`, 60 s lifetime. Run tokens, user auth tokens, MCP
access tokens, and session-broker tokens are rejected with
`401 {"error":"unauthorized"}` everywhere on this surface. The route-policy
class is `webhook` (handler-authenticated); the generic bearer middleware never
grants access here. Sandboxes hold no control-plane credential at all.

## Controller routes

### `POST /workloads` — register or rotate

Request (`credentialEgressWorkloadRegisterSchema`):

```json
{
  "runId": 123,
  "provider": "docker",
  "connectorIdentity": "roomote://api-proxy/run/123/3f9c…",
  "leaseSeconds": 3600
}
```

- `runId`: the attached run. Eligible only if the run status is in
  `activeRunStatuses`, it is attached (`session_tasks`) to exactly one Session,
  that Session is `ownerKind = 'user'`, unarchived, and the run's
  `actingUserId` equals the Session owner, who is not deleted. The owner check is
  made inside the minting transaction, not only in the controller's preflight.
- `connectorIdentity`: a synthetic identity unique per registration (16–512
  printable ASCII chars), unique among active workloads. The column keeps its
  historical name; it is never a certificate claim.
- `leaseSeconds`: 60–86400, default 3600. Leases are renewed only by the
  controller; nothing a sandbox asserts extends one.

Responses:

- `201` `CredentialEgressWorkloadRegistration`:

  ```json
  {
    "workloadId": "uuid",
    "sessionId": "uuid",
    "generation": 1,
    "expiresAt": "ISO-8601",
    "substitutes": [
      {
        "secretRef": "uuid",
        "label": "Example API",
        "origin": "https://api.example.com",
        "headerName": "authorization",
        "headerPrefix": "Bearer ",
        "allowedMethods": ["GET", "HEAD"],
        "expiresAt": "ISO-8601",
        "substitute": "rses_…"
      }
    ]
  }
  ```

  One entry per live grant (unrevoked, unexpired) of the bound Session.
  `substitute` plaintext is returned **once**; the API stores only an
  HMAC-SHA256 (keyed with the deployment encryption key) of it. Deliver it
  only into the workload's client configuration.

- `409 {"error":"run_not_eligible"}` — any eligibility predicate failed.
- `409 {"error":"connector_identity_in_use"}` — another active workload owns
  that identity.
- `400 {"error":"malformed"}`.

Re-registering a run that already has an active workload **rotates** it: same
`workloadId`, `generation + 1`, new identity, all earlier substitutes retired,
a `generation` revocation event recorded, and fresh substitutes minted. Use
this on resume and actor reconciliation. If the run's Session/owner binding
changed, the stale workload is terminated (`detached`) and a new workload is
created instead.

### `POST /workloads/:workloadId/substitutes` — issue for new grants

No body. Returns the same `CredentialEgressWorkloadRegistration` shape containing
only substitutes minted now, i.e. for grants approved after the last
registration/issue in the current generation. Does not rotate. `404
{"error":"workload_not_found"}` if the workload is not active or its live
binding no longer holds.

### `POST /workloads/:workloadId/lease` — renew

Body optional: `{ "leaseSeconds": 3600 }`. `200 { workloadId, generation,
expiresAt }` or `404 {"error":"workload_not_found"}` (inactive, lease already
expired, or binding no longer live — an expired lease is not renewable; re-register).

### `DELETE /workloads/:workloadId` — terminate

Body optional: `{ "reason": "stopped" | "completed" | "failed" |
"provision_failed" | "resumed" | "actor_changed" | "detached" | "orphaned" |
"cleanup" }` (default `cleanup`). Idempotent: `200 { workloadId, terminated:
boolean }`. Retires all substitutes and records a `workload` revocation
event. Controllers must call this on stop, failure, timeout, orphan recovery,
and before snapshot/standby.

## Delivery

Every supported compute provider admits the same way. The sandbox launches
with a bootstrap nonce (`ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_REQUIRED=1`,
`ROOMOTE_CREDENTIAL_EGRESS_BOOTSTRAP_NONCE`) and ordinary connectivity but no
substitutes. After the worker's ordinary bootstrap it marks the nonce ready
and waits. The controller then registers the run through `POST /workloads`
and publishes, bound to that nonce, the substitute-only client configuration:
`ROOMOTE_SERVICE_BASE_URL` (one base URL shared by every approved service),
`ROOMOTE_CREDENTIAL_EGRESS_SERVICES` (the nonsecret manifest), and one
`ROOMOTE_SERVICE_TOKEN_<LABEL>` per grant. No deployment configuration is
needed. The workload never
receives the real credential, a proxy address, or a CA bundle, and nothing
about its networking or inference routing changes.

## API substitution proxy (`/api/credential-egress/<upstream path>`)

The workload points an ordinary HTTP client at the base URL
(`<api origin>/api/credential-egress`, or, when the deployment sets
`R_CREDENTIAL_EGRESS_PROXY_HOST`, the root of that dedicated hostname) and
presents the service's substitute as its credential in any header
(`Authorization: Bearer rses_…`, `x-api-key: rses_…`, `private-token: rses_…`);
the substitute alone names the grant, and the grant's own header name decides
where the origin receives the real key. Grants may name any RFC 7230 header
token except request-shaping ones (see `isCredentialEgressCredentialHeaderName`).

Per request the API performs one live decision, re-joined from the database
with nothing cached: token lookup by hash → workload active and lease
unexpired → generation match → grant not revoked → grant not expired → owner
not deleted and still has integration keys enabled, Session unarchived and
still owned by the same user, grant belongs to that Session/owner, run still
active with `actingUserId = owner`, run still attached to the Session →
approved origin still passes the deployment public-egress policy
(`assertEgressUrlAllowed`, HTTPS) → method in the grant's `allowedMethods`.
Method policy is literal: `HEAD` is not implied by `GET`; the default policy
is `["GET","HEAD"]`.

The path and query are re-rooted on the approved origin; anything that
normalizes to another origin is refused. The client's credential-shaped,
cookie, routing, and hop-by-hop headers are dropped; the grant's own header
slot is set to the real value; redirects are never followed. The response is
buffered (8 MiB cap), scanned for the literal credential and its common
encodings in body and headers, stripped of `set-cookie` and authentication
challenges, and released only after a `response`-phase re-authorization.

After the initial evaluation and its awaited audit insert, an otherwise
allowed decision performs one fresh full-binding SELECT. That READ COMMITTED
snapshot is the authorization decision point; the result and any decrypted
credential are constructed entirely from that final row with no subsequent
awaited work on the allow path. Already forwarded bytes cannot be recalled.

Denials map to bounded reason codes (`unknown_substitute`,
`workload_inactive`, `stale_generation`, `grant_revoked`, `grant_expired`,
`session_unavailable`, `destination_mismatch`, `method_not_allowed`,
`malformed`); the client sees `403 credential_egress_denied` and never the
code's details or any upstream/credential material. A withheld origin
response is `502 credential_egress_upstream_rejected`; concurrency limits are
`429`.

What this path does not provide is a physical origin proof: possession of the
substitute is the authority, bounded by the workload generation, lease, run,
Session, and grant state above. A copied substitute is usable until the run
ends, the lease lapses, or the grant is revoked. Streaming upstreams and
signature-based authentication schemes are out of scope.

## Audit and logging

`credential_egress_audit` records the initial **evaluation attempt** for each
proxied request phase, not its final outcome or proof of released
credentials/bytes. An `allowed` attempt can subsequently be denied by the
fresh read after the audit insert; no final-success meaning should be inferred
from it. The server-generated row `id` uniquely identifies that attempt.
`authorizationId` correlates the request and response phases of one exchange;
it is neither authority nor a unique/final outcome identifier. The attempt
contains: `authorizationId`, `workloadId`, bound
`sessionId`/`actorUserId`/`secretRef`, `phase`, `method`, `destination` as
`host:port` of the approved origin, `decision`, and the bounded `reason` code.
An unknown token names nothing to attribute and is logged, not audited.
Never paths, query strings, headers, bodies, tokens, credentials, or upstream
errors. Handlers log only method, route pattern, and error class on
unexpected failures.

`credential_egress_revocations` keeps an append-only record of explicit
revocations (grant revocation, workload rotation, workload termination) for
operator tooling. It is not the correctness mechanism: every request is
authorized against live state.

## Method policy and consent

`service_credentials.allowed_methods` (default `{GET,HEAD}`) is the grant's method
policy. A prepared approval may request write methods; finalizing such an
approval requires the approving client to echo the exact prepared method set
(`serviceCredentialCreateSchema.allowedMethods`), so a client that never shows the
policy cannot approve a write-capable grant and a successful key entry never
widens an approval. Grants created before this column existed remain
GET/HEAD-only. Both direct broker requests and attached-run proxy requests
enforce `allowed_methods`.

## Lifecycle obligations (controller)

- Register only after the worker reports bootstrap; deliver substitutes, the
  manifest, and the base URL only, bound to the bootstrap nonce.
- Rotate (re-register) on resume and actor reconciliation. Substitutes are
  invalid after restore until re-registration.
- Renew the lease periodically while the run is alive; treat `404` as a signal
  to stop.
- Terminate on stop, completion, failure, orphan recovery, and detach.
- A failed cleanup must not reuse an identity for another Session: the
  active-identity uniqueness index refuses it until the old workload is
  terminated.

## Schema (additive, N-1 safe)

Tables `credential_egress_workloads`, `credential_egress_substitutes`,
`credential_egress_audit`, `credential_egress_revocations`, and the
`allowed_methods` column on `service_credentials` and `service_credential_approvals`
are unchanged by the gateway removal. `connector_identity` keeps its name and
uniqueness index; only the synthetic identity form is written now.
