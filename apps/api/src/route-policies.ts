/**
 * Central route authorization policy manifest for the API server.
 *
 * Every route registered on the API server must be covered by exactly one
 * policy rule below. Enforcement is central (see
 * `middleware/routePolicyMiddleware.ts`): a request that does not satisfy its
 * route's declared policy is rejected before any handler runs, and a request
 * whose path is not covered by any rule is rejected outright (default-deny).
 * The route inventory test (`__tests__/route-policy-inventory.test.ts`)
 * enumerates every registered route and fails when one is not covered, so new
 * routes cannot ship unclassified.
 */

/**
 * - `public`: reachable without credentials (health checks, OIDC discovery).
 *   Token auth middleware may still attach an auth context so handlers can
 *   return richer diagnostics to authenticated callers.
 * - `webhook`: external webhook entry points. The central layer requires no
 *   bearer token; each handler authenticates the delivery itself (HMAC
 *   signature, shared secret, or Bot Framework JWT) before acting on it.
 * - `user`: requires a user-scoped auth token; task run tokens are rejected.
 * - `task-token`: requires a task run token minted for a specific task run;
 *   user auth tokens are rejected.
 * - `authenticated`: requires either a user auth token or a task run token.
 *   Finer-grained checks (run scoping, tool policies) happen in handlers.
 * - `admin`: operator dashboard surface protected by HTTP basic auth
 *   registered in `server.ts` (enforced outside development).
 */
export type RoutePolicyClass =
  | 'public'
  | 'webhook'
  | 'user'
  | 'task-token'
  | 'authenticated'
  | 'admin';

/**
 * How a rate limit derives its bucket key:
 * - `client`: best-effort client IP from proxy headers. Server-to-server
 *   callers that send none of those headers collapse into one shared bucket,
 *   so client-keyed limits must be sized as global ceilings, not per-user
 *   quotas.
 * - `state-token`: SHA-256 of the `state` string field in the JSON request
 *   body. Legitimate callers use a fresh single-use token per flow, so they
 *   never share a bucket; repeated hammering of one token is throttled.
 */
export type RouteRateLimitKeySource = 'client' | 'state-token';

export type RouteRateLimit = {
  keySource: RouteRateLimitKeySource;
  /** Maximum requests allowed per bucket per window. */
  limit: number;
  windowSeconds: number;
};

export type RoutePolicyRule = {
  /** Stable identifier used in logs, rate-limit keys, and tests. */
  name: string;
  match:
    | { type: 'exact'; path: string }
    | {
        /** Matches `path` itself and any path nested under `path + '/'`. */
        type: 'prefix';
        path: string;
      };
  policy: RoutePolicyClass;
  /**
   * Optional rate limits enforced centrally before the handler runs; every
   * listed limit must pass. Fails open when Redis is unavailable so a cache
   * outage cannot take down webhook ingestion.
   */
  rateLimits?: readonly RouteRateLimit[];
  /**
   * Body shape for centrally-emitted rejections. MCP surfaces speak JSON-RPC
   * over Streamable HTTP, so their clients get a JSON-RPC error envelope
   * (matching the in-handler rejections in `handlers/mcp/proxy-utils.ts`)
   * instead of the plain `{ error }` shape.
   */
  errorFormat?: 'plain' | 'json-rpc';
};

/**
 * Generous ceiling for signature-authenticated webhook entry points. Legit
 * providers (GitHub, Slack, Linear, ...) stay far below this; the limit blunts
 * unauthenticated flooding of the public entry points.
 */
const WEBHOOK_RATE_LIMITS: readonly RouteRateLimit[] = [
  {
    keySource: 'client',
    limit: 1200,
    windowSeconds: 60,
  },
];

/**
 * Ordered rule table; the first matching rule wins. Keep more specific rules
 * (exact paths, longer prefixes) above broader prefixes.
 */
export const ROUTE_POLICY_RULES: readonly RoutePolicyRule[] = [
  // Health checks. `/` is the load balancer's deep health check.
  {
    name: 'health-root',
    match: { type: 'exact', path: '/' },
    policy: 'public',
  },
  {
    name: 'health-api',
    match: { type: 'prefix', path: '/health/api' },
    policy: 'public',
  },
  {
    name: 'health-liveness',
    match: { type: 'prefix', path: '/health/liveness' },
    policy: 'public',
  },
  {
    name: 'health-controller',
    match: { type: 'prefix', path: '/health/controller' },
    policy: 'public',
  },

  // Sandbox OIDC discovery documents consumed by external verifiers.
  {
    name: 'oidc-discovery',
    match: { type: 'exact', path: '/.well-known/openid-configuration' },
    policy: 'public',
  },
  {
    name: 'oidc-jwks',
    match: { type: 'exact', path: '/api/oidc/jwks' },
    policy: 'public',
  },

  // Teams OAuth resume: called server-to-server by the web app after account
  // linking to resume a pending Teams conversation, authenticated by a
  // single-use random-UUID state token in the body. The primary limit is
  // keyed on the state token so concurrent legitimate users (who all arrive
  // from the web app's egress IP with distinct tokens) never share a bucket,
  // while hammering any one token is throttled. Guessing across the 122-bit
  // token space is cryptographically infeasible either way. The client-keyed
  // limit is a deliberately high global volumetric ceiling (far above any
  // plausible legitimate account-linking rate) because the web app sends no
  // client-identifying headers and would collapse into one bucket.
  {
    name: 'webhook-teams-auth-resume',
    match: { type: 'exact', path: '/api/webhooks/teams/auth/resume' },
    policy: 'webhook',
    rateLimits: [
      { keySource: 'state-token', limit: 10, windowSeconds: 60 },
      { keySource: 'client', limit: 300, windowSeconds: 60 },
    ],
  },

  // Signature-authenticated webhook entry points. Each handler verifies the
  // provider's signature/secret before processing the delivery.
  {
    name: 'webhook-cloud-github',
    match: { type: 'prefix', path: '/api/webhooks/cloud/github' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-github',
    match: { type: 'prefix', path: '/api/webhooks/github' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-gitlab',
    match: { type: 'prefix', path: '/api/webhooks/gitlab' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-gitea',
    match: { type: 'prefix', path: '/api/webhooks/gitea' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-bitbucket',
    match: { type: 'prefix', path: '/api/webhooks/bitbucket' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-ado',
    match: { type: 'prefix', path: '/api/webhooks/ado' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-slack',
    match: { type: 'prefix', path: '/api/webhooks/slack' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-linear',
    match: { type: 'prefix', path: '/api/webhooks/linear' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-teams',
    match: { type: 'prefix', path: '/api/webhooks/teams' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },
  {
    name: 'webhook-telegram',
    match: { type: 'prefix', path: '/api/webhooks/telegram' },
    policy: 'webhook',
    rateLimits: WEBHOOK_RATE_LIMITS,
  },

  // Router-facing MCP endpoints: accept user auth tokens (LLM router
  // gathering context before a run exists) and task run tokens.
  {
    name: 'mcp-routing',
    match: { type: 'prefix', path: '/api/mcp-routing' },
    policy: 'authenticated',
    errorFormat: 'json-rpc',
  },

  // Worker/agent MCP surface. `mcpAuthMiddleware` and the per-integration
  // resolvers apply finer-grained token-type checks per endpoint.
  {
    name: 'mcp',
    match: { type: 'prefix', path: '/api/mcp' },
    policy: 'authenticated',
    errorFormat: 'json-rpc',
  },

  // Task run log streaming: run tokens are scoped to their own run inside
  // the handler; user tokens may stream any run in the deployment.
  {
    name: 'task-runs',
    match: { type: 'prefix', path: '/api/task-runs' },
    policy: 'authenticated',
  },

  // Artifact APIs are only available to task run tokens.
  {
    name: 'artifacts',
    match: { type: 'prefix', path: '/api/artifacts' },
    policy: 'task-token',
  },
  {
    name: 'task-artifacts',
    match: { type: 'prefix', path: '/api/tasks' },
    policy: 'task-token',
  },

  // tRPC surface used by the web app (user tokens) and workers (run tokens).
  // Per-procedure middleware applies user-only and run-scoped checks.
  {
    name: 'trpc',
    match: { type: 'prefix', path: '/trpc' },
    policy: 'authenticated',
  },

  // Operator dashboard mount; HTTP basic auth is registered in `server.ts`.
  {
    name: 'admin',
    match: { type: 'prefix', path: '/admin' },
    policy: 'admin',
  },
];

function ruleMatches(rule: RoutePolicyRule, path: string): boolean {
  if (rule.match.type === 'exact') {
    return path === rule.match.path;
  }

  return path === rule.match.path || path.startsWith(`${rule.match.path}/`);
}

/**
 * Resolve the policy rule for a request path. Returns undefined when the path
 * is not covered by any rule, in which case the request must be rejected
 * (default-deny).
 */
export function findRoutePolicyRule(path: string): RoutePolicyRule | undefined {
  return ROUTE_POLICY_RULES.find((rule) => ruleMatches(rule, path));
}
