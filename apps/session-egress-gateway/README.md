# Session Egress: Iron Distribution

This binary is actual [Iron](https://github.com/ironsh/iron-proxy), built inside
Iron's original Go module with a checked-in Roomote overlay. It is not an
Iron-inspired replacement proxy. Upstream is Apache-2.0; its LICENSE
remains in the extracted build source.

## Reproducible Source

`iron.lock` pins Git commit `2393dd175a8c419153fb49917fdeceb94cd9ed59` and
codeload tarball SHA-256
`651cd4745193252a997b476ea022a852428db666a59e6554cbc3e786b320d3ec`.
`bash build.sh` fetches the SHA-addressed archive, verifies its hash and member
paths, extracts into ignored `.build/`, copies `overlay/`, applies exact
fail-on-drift hooks, and builds with `mise exec go@1.26.1 --`.
Upstream `go.mod` and `go.sum` are retained unchanged. No root Go module,
replacement transport, custom MITM implementation, or vendored source snapshot
is maintained here.

Entry path:

```text
overlay/cmd/iron-proxy/roomote.go: main
  internal/roomote.Main -> runGateway
    internal/certcache.New (actual Iron leaf certificate cache)
    internal/transform.NewPipeline (Roomote Go Transformer)
    internal/proxy.New -> ListenAndServe -> ServeConnector
      Iron handleTunnelCONNECT -> serveTunnelTLS -> handleHTTP
      Iron buildTransport -> transport.RoundTrip
      Iron response writer / SSE writer with live release gate
```

The upstream `cmd/iron-proxy/main.go` entry function is renamed `ironMain`.
It cannot be selected by arguments or environment; this distribution does not
permit Iron standalone, managed, DNS, SOCKS, SNI passthrough, MCP, secret-provider,
or response-retry configuration. The small `patch-iron.mjs` hook set retains
Iron's ordinary behavior outside the connector mode so upstream unit tests
continue to exercise the same implementation.

Iron's existing external gRPC transform sends `client_cert_der` and tunnel
traces, but exposes only request/response RPCs. It cannot install an idle
authorization watcher, cancel the in-flight upstream context, or gate each
downstream write. The same-module Go `Transformer` therefore owns policy;
the targeted Iron hooks propagate the verified outer certificate and expose
exchange-finalization and response-release boundaries. No new gRPC service or
replacement MITM transport is introduced. The runtime image includes upstream's
Apache-2.0 LICENSE and `iron.lock` provenance.

## Security Contract

The gateway uses the existing Roomote
[`/authorize` contract](../api/src/handlers/session-egress/CONTRACT.md):

- Outer connector TLS requires a verified client certificate from the configured
  client CA, exactly one SPIFFE connector URI and one
  `roomote://workload/<uuid>` URI. No subject-CN fallback or identity header.
  The trusted certificate is propagated through Iron's CONNECT tunnel metadata.
- CONNECT is admission only: authenticate connector and validate the explicit
  lowercase DNS `host:port`. No substitute is required or resolved there.
- Inner TLS is mandatory. CONNECT target, SNI, Host and any absolute request URL
  must agree, including the exact HTTPS port. IP literal origins are refused.
- Only `authorization`, `x-api-key`, or `api-key` can hold one whole substitute.
  The returned grant must match that slot and the presented authentication scheme
  (`Bearer `, `Basic `, `Token `, or empty). Only the scheme is case-insensitive;
  substitute values remain case-sensitive and spacing remains exact. Injection
  uses the grant's canonical prefix. A second auth slot or duplicate
  value is denied. Paths, queries, bodies and other headers never supply
  authority or receive credential substitution. Request bodies are not scanned
  or buffered and retain their bytes; absent bodies remain `http.NoBody`.
- Live HTTPS `/authorize` requests carry the authenticated workload and connector
  on request, response, every response write/flush, and every 250 ms while idle.
  No positive decision cache, credential cache, or configuration reload is used
  for revocation. API timeout is bounded; any error or denial closes authority.
- Credentials are accepted only on the request-phase response and injected
  only into the agreed header. No customer keys are configuration inputs.
  WebSocket upgrades and gRPC are rejected. No unauthenticated passthrough.
- Public egress is checked on every resolved address; mixed public/private
  results fail closed. Vetted IPs are pinned for dial, with a second final socket
  guard. TLS certificate validation remains on. No production private-CIDR,
  alternate upstream proxy, extra upstream CA or TLS-disable setting is exposed.
- Response headers, trailers and bytes are scanned for literal, common
  percent-encoded, base64-aligned, JSON-escaped and hex echoes. Fully Unicode-escaped
  JSON may mix hex-digit casing within and between valid lowercase `\u` escapes;
  matching does not fold raw credential values. Non-identity
  content encodings fail closed. Trailers are scanned but never forwarded.
  Redirects are not followed and Location/Alt-Svc are stripped.
- Known-length responses up to the configured bound are fully scanned before
  release. Larger, unknown-length and SSE responses use a bounded cross-read
  holdback window without truncating total length. The overlay deliberately
  bypasses Iron `BufferedBody.Read`, whose upstream limit truncates silently.
- An idle ticker cancels upstream requests even before response headers arrive.
  Grant expiry and connector certificate expiry are hard context deadlines.
  Cancellation stops blocked downstream writes; stream errors abort HTTP rather
  than synthesizing a clean EOF. The exchange cleanup always stops its watcher.

## Configuration

All gateway configuration is infrastructure configuration. Required variables:

| Variable | Meaning |
| --- | --- |
| `SESSION_EGRESS_API_URL` | Exact HTTPS control-plane origin, no credentials/path/query/fragment |
| `SESSION_EGRESS_GATEWAY_TOKEN` | Dedicated API gateway token, at least 32 characters |
| `SESSION_EGRESS_SERVER_CERT_FILE` | Outer gateway TLS certificate PEM |
| `SESSION_EGRESS_SERVER_KEY_FILE` | Outer gateway TLS private key |
| `SESSION_EGRESS_CLIENT_CA_FILE` | Trusted connector issuing CA PEM |
| `SESSION_EGRESS_MITM_CA_CERT_FILE` | Iron MITM issuing CA certificate PEM |
| `SESSION_EGRESS_MITM_CA_KEY_FILE` | Iron MITM issuing CA private key |

Optional: `SESSION_EGRESS_LISTEN_ADDR` (default `:8443`),
`SESSION_EGRESS_AUTHORIZE_TIMEOUT` (default `2s`, positive and at most `5s`),
`SESSION_EGRESS_MAX_BUFFERED_RESPONSE_BYTES` (default/max `8388608`).
Leaf lifetime is 24 hours with a 512-entry Iron certificate cache.

Startup rejects the obsolete `SESSION_EGRESS_ALLOW_PASSTHROUGH`,
`SESSION_EGRESS_ALLOWED_PRIVATE_CIDRS`,
`SESSION_EGRESS_STREAM_AUTHORIZE_INTERVAL`,
`SESSION_EGRESS_UPSTREAM_CA_FILE`, and `SESSION_EGRESS_METRICS_ADDR` settings.
There is no metrics listener. The gateway never receives the controller job
signing key; private gateway/connector infrastructure keys stay outside workloads.

`session-egress-gateway connector` retains the separate plain CONNECT relay:
`SESSION_EGRESS_CONNECTOR_LISTEN_ADDR` (default `:3128`), required
`SESSION_EGRESS_CONNECTOR_GATEWAY_ADDR`, `SESSION_EGRESS_CONNECTOR_CERT_FILE`,
`SESSION_EGRESS_CONNECTOR_KEY_FILE`, optional
`SESSION_EGRESS_CONNECTOR_GATEWAY_CA_FILE` and
`SESSION_EGRESS_CONNECTOR_GATEWAY_SERVER_NAME`.
It does not terminate inner TLS or implement MITM. Bind it only to its workload
network and keep its certificate/key inaccessible to the workload.

## Logging and Final Outcomes

Iron's unrestricted diagnostic logger is disabled in this distribution because
it can include request paths and upstream error text. The pipeline audit callback
is not installed: CONNECT admission is not a completed inner exchange.
Each inner exchange reaching Iron's HTTP handler emits exactly one `session_egress_final`,
including early rejections, with validated authorizationId/workloadId when known
(empty otherwise) and one terminal outcome:

- `forwarded`: the response passed policy and body safety checks and Iron finished
  writing it without a reported error or cancellation. Not proof the client consumed it.
- `rejected`: initial admission, response safety, or forwarding failed without
  an exchange context cancellation. No success is inferred from request authorization.
- `canceled`: the context ended, including revocation, expiry, control-plane outage
  after admission, or client cancellation. Previously streamed bytes cannot be recalled.

Finalization is guarded against duplicate calls and waits for the idle watcher to
stop. Events contain no path, query, substitute, credential, body or upstream error.
Iron's pre-policy rejects use a logging-only fallback with empty correlation IDs;
the fallback is suppressed when the policy finalizer owns the event. CONNECT and
TLS/HTTP parsing failures before the inner HTTP handler have no inner final event.
These gateway events are not the API database's initial evaluation-attempt records;
an initial attempted allow is never proof of final forwarding.

**Interim milestone:** there is currently no final-outcome API route in
the shared contract. These events are local structured logs, not persisted API
outcomes. A future authenticated, idempotent final-outcome endpoint must define
its path, schema, gateway-generated unique event identifier, bounded result
codes, linkage to authorizationId/workloadId, duplicate handling, and retry
behavior. authorizationId is caller-controlled correlation, not a unique audit
row or proof of delivery. No nonexistent endpoint is called here.

## Validation and Limits

```sh
bash build.sh test   # -race: Roomote overlay + actual Iron proxy/transform/certcache tests
bash build.sh vet
bash build.sh build
bin/session-egress-gateway version
```

Fixtures use only local httptest authorization/upstream TLS servers and generated
test PKI. Test-only Go options supply loopback dial mapping and trusted roots;
there is no environment equivalent in production. No product E2E, provider
provisioning, live customer API, Docker deployment or browser verification is
claimed by these tests.

Streaming bytes already emitted cannot be recalled. Supported echo encodings are
finite; partial, encrypted, mixed arbitrary encodings or covert transformations
by a malicious approved upstream are outside the guarantee. Ordinary calls
without substitutes are denied; this is not a general unrestricted internet
proxy. CONNECT alone does not validate a live grant. The revocation acceleration
feed is not consumed; correctness uses per-boundary checks, idle polling and
deadlines. Positive lease extensions for the same valid workload/generation are
accepted without changing an existing exchange's original hard deadline. A
shortening relative to the most recent validated expiry fails closed, as do
revocation, identity changes and expiry. New requests can use the renewed lease;
existing requests and streams still end at their original deadline. Connector certificate
revocation requires removing its workload binding or trust plus connection
cleanup; the certificate is not itself a live grant.
## Authenticated Shared Proxy Mode

The same actual-Iron gateway can optionally expose an additional HTTPS CONNECT
listener. Set `SESSION_EGRESS_AUTHENTICATED_PROXY_LISTEN_ADDR` (for example
`:8444`), `SESSION_EGRESS_PROXY_SERVER_CERT_FILE`, and
`SESSION_EGRESS_PROXY_SERVER_KEY_FILE` on the gateway. This requires a reachable
TLS forward-proxy endpoint whose ingress supports HTTP/1.1 CONNECT and long-lived
tunnels; a normal web route or reverse-proxy path is not equivalent. Existing
gateway/API/MITM CA configuration and the stronger external-mTLS listener are
unchanged. Do not put gateway API credentials or private signing keys in workers.

Clients use standard Basic proxy authentication with username `workload` and the
scoped opaque proxy capability as password. The gateway validates it server-side,
then requires the independently issued service substitute inside the MITM TLS
tunnel. Proxy authorization and reserved internal headers are removed before
upstream forwarding. Bare CONNECT tunnels and active/idle HTTP streams are
revalidated and closed on denial, expiry or authorization-service failure.

This is credential containment with transferable logical identity, not forced
egress or nontransferable physical-workload identity. A valid stolen capability
plus its matching substitute can be replayed until invalidated. It cannot replace
a connector certificate on the external-mTLS listener, and a connector certificate
cannot replace proxy authentication on the new listener.

Use the public CA bundle for both proxy-server TLS (when privately signed) and
the inner service certificate. Curl supports standard proxy authentication and
`--proxy-cacert`/`--cacert`; SDK proxy and trust support depends on the exact
transport/runtime. Do not assume every SDK consumes `HTTPS_PROXY`. Client-specific
configuration leaves bootstrap, inference and unrelated traffic on their existing
routes. There are no new model-facing request tools. Hosted worker delivery and
refresh remain required integration steps, not claims established by this listener.
