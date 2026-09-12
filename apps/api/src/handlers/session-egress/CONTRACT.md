# Session egress control plane: gateway/controller -> API contract

Base path: `/api/internal/session-egress` (constant
`SESSION_EGRESS_CONTROL_PLANE_PATH` in `@roomote/types`). All bodies are JSON.
Schemas and response types live in `packages/types/src/session-egress.ts`;
persistence in `packages/db/src/lib/session-egress.ts`; the service layer and a
typed controller client in `packages/sdk/src/server/lib/session-egress.ts`.

This document is the contract the Iron-based gateway extension and the
controller integration are written against. It describes milestone 1 (control
plane only). Gateway build/deployment, connector networking, provider egress
enforcement, and worker client configuration are separate milestones.

## Threat model in one paragraph

Workloads (attached coding runs) receive only opaque **substitute tokens**
(`rses_` + 32 random bytes, base64url) plus the gateway's public CA. The real
credential exists only encrypted at rest and, per request, in gateway memory
after this API resolves it. Nothing a sandbox can send is authority: not a
Session ID, not a header, not the substitute alone. Authority is the
conjunction of an authenticated **connector identity** (established by the
gateway outside the sandbox, e.g. connector mTLS), the workload registration
the trusted controller created for that identity, the workload generation the
substitute was minted in, and the live owner/Session/attached-run/grant state
re-joined on every call.

## Principals and authentication

The surface is disabled (every route returns `404 {"error":"not_found"}`)
until `R_SESSION_EGRESS_GATEWAY_TOKEN` (>= 32 chars) is configured on the API.

| Principal    | Credential                                                                                                                  | Routes                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `controller` | `Authorization: Bearer <ES256 JWT>` minted by `createSessionEgressControllerToken()` (`@roomote/auth`) with the deployment `JOB_AUTH_PRIVATE_KEY`; `aud=roomote-session-egress-controller`, `sub=roomote-controller`, 60 s lifetime | `POST /workloads`, `POST /workloads/:id/substitutes`, `POST /workloads/:id/lease`, `DELETE /workloads/:id` |
| `gateway`    | `Authorization: Bearer <R_SESSION_EGRESS_GATEWAY_TOKEN>` (constant-time compared)                                          | `POST /authorize`, `GET /revocations`               |

Run tokens, user auth tokens, MCP access tokens, and session-broker tokens are
rejected with `401 {"error":"unauthorized"}` everywhere on this surface. A
valid principal on the other principal's route gets
`403 {"error":"forbidden_principal"}`. The route-policy class is `webhook`
(handler-authenticated); the generic bearer middleware never grants access here.

The gateway is an external binary and must never hold the job-auth signing key;
that is why it gets a dedicated shared secret while the controller reuses the
key it already has. Sandboxes hold neither.

## Controller routes

### `POST /workloads` — register or rotate

Request (`sessionEgressWorkloadRegisterSchema`):

```json
{
  "runId": 123,
  "provider": "docker",
  "connectorIdentity": "spiffe://roomote/connector/3f9c…",
  "leaseSeconds": 3600
}
```

- `runId`: the attached run. Eligible only if the run status is in
  `activeRunStatuses`, it is attached (`session_tasks`) to exactly one Session,
  that Session is `ownerKind = 'user'`, unarchived, and the run's
  `actingUserId` equals the Session owner, who is not deleted.
- `connectorIdentity`: the identity the gateway will authenticate at connection
  time (16–512 printable ASCII chars). Unique among active workloads.
- `leaseSeconds`: 60–86400, default 3600. Leases are renewed only by the
  controller; nothing a sandbox asserts extends one.

Responses:

- `201` `SessionEgressWorkloadRegistration`:

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
`workloadId`, `generation + 1`, new `connectorIdentity`, all earlier
substitutes retired, a `generation` revocation event published, and fresh
substitutes minted. Use this on resume, actor reconciliation, and connector
credential rotation. If the run's Session/owner binding changed, the stale
workload is terminated (`detached`) and a new workload is created instead.

### `POST /workloads/:workloadId/substitutes` — issue for new grants

No body. Returns the same `SessionEgressWorkloadRegistration` shape containing
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
boolean }`. Retires all substitutes and publishes a `workload` revocation
event. Controllers must call this on stop, failure, timeout, orphan recovery,
and before snapshot/standby.

## Gateway routes

### `POST /authorize` — live per-phase authorization

The gateway calls this **before forwarding** the inner HTTP request
(`phase: "request"`), **before releasing** a buffered response
(`phase: "response"`), and **at each emission boundary** of a streaming
response (`phase: "stream"`). Every call re-joins live state; there is no
server-side caching and the gateway must not cache positive decisions or
credentials across requests.

Request (`sessionEgressAuthorizeSchema`):

```json
{
  "workloadId": "uuid",
  "connectorIdentity": "spiffe://roomote/connector/3f9c…",
  "substitute": "rses_…",
  "destination": { "host": "api.example.com", "port": 443 },
  "method": "POST",
  "path": "/v1/things",
  "phase": "request",
  "authorizationId": "uuid (echo the value from the request phase)"
}
```

- `workloadId` and `connectorIdentity` come from the gateway's own connector
  authentication and its registration mapping — never from request headers.
- `substitute` is the whole credential value the client sent in the approved
  header position, after stripping the approved prefix. Substring matching
  across headers/bodies is not part of this contract.
- `destination.host` is the lowercase DNS name the client addressed (CONNECT
  authority, SNI, and `Host`/`:authority` must all agree before calling);
  literal IPs are rejected as `malformed`. `port` is the real destination port.
- `path` is validated for shape only and is never stored or logged.
- `authorizationId` is optional caller-controlled correlation, generated by
  the API when omitted. Reusing an ID never grants authority, proves an earlier
  phase succeeded, or skips any live binding check.

Response is always `200` with `Cache-Control: no-store`:

- Allowed, request phase:

  ```json
  {
    "allowed": true,
    "authorizationId": "uuid",
    "workloadId": "uuid",
    "generation": 2,
    "sessionId": "uuid",
    "secretRef": "uuid",
    "expiresAt": "ISO-8601, earliest of grant expiry and workload lease expiry",
    "credential": { "headerName": "authorization", "headerPrefix": "Bearer ", "value": "<real key>" }
  }
  ```

  The gateway replaces the approved header with `headerPrefix + value`,
  forwards, and discards `value` after the exchange. It must close any
  stream at `expiresAt` at the latest.

- Allowed, response/stream phases: same object without `credential`.
- Denied: `{ "allowed": false, "reason": <code> }` where `reason` is one of
  `malformed`, `unknown_substitute`, `workload_mismatch`, `workload_inactive`,
  `stale_generation`, `grant_revoked`, `grant_expired`, `session_unavailable`,
  `destination_mismatch`, `method_not_allowed`. The gateway returns a generic
  failure to the client, never the code's details or any upstream/credential
  material.

Decision order (first failing rule wins): token lookup by hash →
workload/connector binding → workload active and lease unexpired → generation
match → grant not revoked → grant not expired → owner not deleted, Session
unarchived and still owned by the same user, grant belongs to that
Session/owner, run still active with `actingUserId = owner`, run still
attached to the Session → exact `host:port` equals the approved origin
(default port 443) and that origin still passes the deployment public-egress
policy (`assertEgressUrlAllowed`, HTTPS) → method in the grant's
`allowedMethods`.

Method policy is literal: `HEAD` is not implied by `GET`. A grant prepared
with `["GET"]` denies `HEAD`; the default policy is `["GET","HEAD"]`.

After the initial evaluation and its awaited audit insert, an otherwise allowed
call performs one fresh full-binding SELECT. That READ COMMITTED snapshot is
the authorization decision point; the result and any decrypted credential are
constructed entirely from that final row with no subsequent awaited work on
the allow path. Changes committed while the audit write was blocked therefore
cannot release stale authority. This does not eliminate distributed TOCTOU
after the final snapshot: the gateway must still enforce `expiresAt`, perform
every phase check, and honor cancellation. Already forwarded bytes cannot be
recalled.

Any non-2xx or transport failure from this endpoint is a **fail-closed**
denial for the gateway. A `200` with `allowed:false` (including `malformed`)
is a terminal decision for that exchange, not something to retry.

### `GET /revocations?after=<cursor>&limit=<1..500>` — acceleration feed

```json
{
  "events": [
    { "id": 42, "kind": "grant", "workloadId": null, "secretRef": "uuid", "generation": null, "createdAt": "ISO-8601" },
    { "id": 43, "kind": "generation", "workloadId": "uuid", "secretRef": null, "generation": 2, "createdAt": "…" },
    { "id": 44, "kind": "workload", "workloadId": "uuid", "secretRef": null, "generation": null, "createdAt": "…" }
  ],
  "cursor": 44
}
```

Append-only, ordered by `id`; poll with the returned `cursor`. Use it to
cancel in-flight connections/streams early. Only explicit actions produce
events: grant revocation (`grant`), workload rotation (`generation`), and
workload termination (`workload`). It is **not** the correctness mechanism:
owner removal, archive, detach, actor change, grant expiry, and lease expiry
produce no event and are enforced by `/authorize` (and by the `expiresAt`
the gateway received) alone.

## Audit and logging

`session_egress_audit` records the initial **evaluation attempt** for each
schema-valid `/authorize` call, not its final outcome or proof of released
credentials/bytes. An `allowed` attempt can subsequently be denied by the
fresh read after the audit insert; no final-success meaning should be inferred
from it. The server-generated row `id` uniquely identifies that attempt.
`authorizationId` is caller-controlled correlation and may repeat across
unrelated calls; it is neither authority nor a unique/final outcome identifier.
The attempt contains: `authorizationId`,
presented `workloadId`, bound `sessionId`/`actorUserId`/`secretRef` (only when
the token actually belongs to the presented workload), `phase`, `method`,
`destination` as `host:port`, `decision`, and the bounded `reason` code.
Never paths, query strings, headers, bodies, tokens, credentials, or upstream
errors. The handler logs only method, route pattern, and error class on
unexpected failures. Gateways must apply the same rule: no body capture, no
credential-bearing annotations, no full URLs.

## Method policy and consent

`session_secrets.allowed_methods` (default `{GET,HEAD}`) is the grant's method
policy for the gateway path. A prepared approval may request write methods;
finalizing such an approval requires the approving client to echo the exact
prepared method set (`sessionSecretCreateSchema.allowedMethods`), so a client
that never shows the policy cannot approve a write-capable grant and a
successful key entry never widens an approval. Grants created before this
column existed remain GET/HEAD-only. The legacy `integration_request`
Session-grant path stays GET/HEAD-only regardless of `allowed_methods`.

## Lifecycle obligations (controller)

- Register after the workload's connector exists and before the workload can
  reach the gateway; deliver substitutes + proxy settings + public CA only.
- Rotate (re-register) on resume from snapshot, actor reconciliation, and
  connector credential rotation. Substitutes are invalid after restore until
  re-registration.
- Renew the lease periodically while the run is alive; treat `404` as a signal
  to re-register or stop.
- Terminate on stop, completion, failure, orphan recovery, and detach.
- A failed cleanup must not reuse a connector identity for another Session:
  the active-connector uniqueness index refuses it until the old workload is
  terminated.

## Schema (additive, N-1 safe)

Migration `packages/db/drizzle/0082_wooden_cardiac.sql`: new tables
`session_egress_workloads`, `session_egress_substitutes`,
`session_egress_audit`, `session_egress_revocations`; new column
`allowed_methods text[] NOT NULL DEFAULT '{GET,HEAD}'` on `session_secrets`
and `session_secret_approvals`. No existing column or table changes shape;
the previous release ignores all of it.

## Out of scope here (later milestones)

Iron gateway extension (connector identity → workload mapping, CONNECT/SNI/
Host binding, header-position substitution, response echo containment,
stream cancellation), Docker/provider connector networking and egress
enforcement, worker client trust/proxy configuration, Fast delegation
guidance, and removal of the deprecated `integration_request` Session-grant
compatibility path after parity tests.
