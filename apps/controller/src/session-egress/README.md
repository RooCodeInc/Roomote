# Docker Session Egress Runtime Checkpoint

This is an intermediate implementation, not proof of complete provider parity or
isolated Fast execution. Product and privileged-child bypass validation must run
against the exact delivered commit before readiness is established.

## Normal Fresh-Task Path

1. The controller preflights live Session ownership/grants without minting tokens.
2. The ordinary worker image and release archive are installed through the existing
   Docker path. The archive is supplied by the controller, not downloaded by the agent.
3. The worker performs normal repository checkout, tool installation and environment
   setup with ordinary bootstrap networking and **no Session substitutes**. Protected
   runs wait for environment setup instead of starting the model in parallel.
4. The worker marks a per-attempt nonce ready and waits. This is only a transition
   request, not evidence of enforcement or credential authority.
5. The controller revalidates eligibility, registers a generation, provisions an
   external connector using the actual pinned Iron binary's `connector` command,
   and verifies the worker's host veth using Docker metadata plus reciprocal kernel
   peer indices and the host-assigned target namespace ID. Worker-provided link
   indices alone are not trusted; fabricated/ambiguous topology is refused.
6. Host bridge rules are installed and checked before delivery. They bind the physical
   worker veth, not a claimed source IP or an agent-controlled namespace. Only the
   connector and fixed API/preview TCP endpoints are permitted. Established public
   connections are not grandfathered; only replies to trusted endpoint connections
   have a scoped conntrack exception. IPv6, UDP and host-local traffic are denied.
7. The controller installs only the public CA bundle and publishes an encrypted,
   short-lived, nonce/run/generation-bound handoff. The API checks signed-user/run,
   live Session owner/attachment/actor and generation after reading the handoff.
8. Only then does the worker load substitute-only client environment and begin the
   model. curl, Node's environment proxy support and Python clients use the proxy
   and public trust bundle; no TLS-verification bypass is set.

Surviving setup processes and privileged nested-Docker children share the worker
namespace, not the host's firewall authority. Namespace rules are defense in depth;
the host filter is the boundary. Host/kernel compromise is not within this guarantee.
Actual packets, old sockets, child host networking, spoofing and resume are required
independent product tests, not established by command-generation unit assertions.

## Configuration and Prerequisites

`deploy/compose/docker-compose.session-egress.yml` is the optional overlay on the
normal production Compose definition. Build the pinned gateway image using its
checked-in Dockerfile and set `SESSION_EGRESS_CONNECTOR_IMAGE` to that image. Supply
an operator-owned `SESSION_EGRESS_INFRA_DIR`, outside repositories/workspaces, with:

- gateway server certificate/key (SAN `session-egress-gateway`) and its public CA;
- connector issuing CA certificate/key;
- MITM issuing CA certificate/key.

The overlay mounts private material only into the controller/gateway. The worker
receives no issuing key or connector private key. `R_SESSION_EGRESS_GATEWAY_TOKEN`
is dedicated infrastructure authentication and is hard-denied by worker env builders.
`SESSION_EGRESS_API_URL` must be a verified HTTPS origin routing the internal API;
the API and controller retain their normal database/Redis/signing/encryption config.

The trusted worker/helper image needs Node, `ip`, `iptables`, `ip6tables`, a
system CA bundle and the normal worker prerequisites. Namespace inspection runs
in a separate trusted helper with host PID/network access; it attaches and removes
a private temporary namespace name and never executes workload filesystem binaries.
The Docker host must have
bridge netfilter enabled for IPv4/IPv6 and its `FORWARD -> DOCKER-USER` hook installed.
Missing capability fails admission without substitutes. Fixed Compose control ports
are API 3001 and preview 8081. No private/issuing key is placed in workspace volumes.

### Protected inference

The worker constructs `R_INFERENCE_GATEWAY_URL` from its container-reachable
`workerEnv.trpcUrl`, not the public web origin. For the supplied Compose deployment
this is `http://api:3001/api/inference`. Existing `mergeInferenceGatewayProviderConfig`
rewrites served providers, for example OpenRouter, to
`http://api:3001/api/inference/openrouter/v1` using the scoped run-token reference.
The delivered `NO_PROXY` and `no_proxy` include `api`; the fixed host policy permits
API TCP port 3001. Provider keys/run tokens are not sent through grant-only Iron.
Protected startup explicitly rejects selected providers without a gateway-backed
configuration. Direct provider/custom base configurations are unsupported unless
the deployment's existing inference gateway serves and advertises them. This is
checked against the final generated provider configuration, not just an env hint.

After transition, new arbitrary dependency downloads are deliberately not bypassed
around the gateway. Install declared dependencies during normal setup. Future
trusted post-bootstrap provisioning is separate work; do not manually preload test
containers and claim that establishes normal bootstrap.

## Resume, Failure and Cleanup

On retained resume, the source run's workloads are terminated and its old connector
removed before bootstrap. Its old host policy is removed only after that invalidation.
The new attempt has a fresh nonce and must repeat verified admission. Legacy retained
networks lacking controller-owned policy labels fail closed; use a fresh task.

The live API validates lease renewals. The controller renews only after admission;
outage or terminal/reattachment denial stops renewal and existing leases expire.
Existing exchange deadlines and connector certificate expiry remain hard limits.
Controller restart recovery and mid-run addition of new grants remain unfinished;
start/resume currently supplies the grant set. These are not parity completion claims.

Normal run finalization terminates workload records. Stop/destroy/provision failure
removes the exact connector container and worker/task daemon as appropriate. Network
cleanup removes only the `RSE_<network-id-prefix>` policy chains and jumps, after
task endpoints are stopped/disconnected; it never flushes global firewall policy.
Failed transition never publishes client configuration. Pending handoffs expire in
120 seconds and stale/terminated generations cannot read or use them.

For manual test cleanup, use the normal task stop/destroy path, identify resources
using their managed run labels, and verify workload termination before removing the
specific connector/network. Do not flush global iptables, delete unrelated networks,
or expose private certificate material in diagnostic output.

## Provider Matrix

| Provider | Current code/API evidence | Checkpoint status / remaining contract |
| --- | --- | --- |
| Docker | Host Docker lifecycle, per-task bridge, external connector and host filter | Implemented here; independent product bypass tests outstanding |
| Modal | Provider API has network/CIDR/domain controls and OIDC support; adapter does not wire them | Implement adapter and external connector admission; OIDC bearer alone is not nontransferable workload identity |
| Daytona | Installed SDK exposes networkBlockAll/networkAllowList/domainAllowList | Verify create/update enforcement and implement external admission, lifecycle and trust delivery |
| E2B | Installed SDK exposes sandbox network-policy update API | Wire provider policy and prove independent workload-to-connector binding |
| Blaxel | Existing adapter has create/exec/file lifecycle, no verified egress contract in the inspected SDK | Obtain/verify enforceable provider networking and isolated connector contract; not declared impossible |
| Box | Direct API lifecycle adapter; no verified network/identity contract | Implement against verified external API or report required provider change |
| Azure | Sandbox create request has coarse egressPolicy/inspection controls | Verify granular route enforcement and external workload admission; control-plane managed identity is not workload identity |
| Roomote broker | Hosting broker fronts Modal with tenant-scoped control authentication | Extend the hosting contract; do not send connector identity private keys into workloads |

All non-Docker adapters currently fail closed for this capability. This is staging,
not acceptance of Docker-only completion. Isolated general execution for Fast is
also still required; mandatory resource-request tools are not its replacement.
