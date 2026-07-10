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

export type RouteRateLimit = {
  /** Maximum requests allowed per client per window. */
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
   * Optional per-client rate limit enforced centrally before the handler
   * runs. Fails open when Redis is unavailable so a cache outage cannot take
   * down webhook ingestion.
   */
  rateLimit?: RouteRateLimit;
};

/**
 * Generous ceiling for signature-authenticated webhook entry points. Legit
 * providers (GitHub, Slack, Linear, ...) stay far below this; the limit blunts
 * unauthenticated flooding of the public entry points.
 */
const WEBHOOK_RATE_LIMIT: RouteRateLimit = {
  limit: 1200,
  windowSeconds: 60,
};

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

  // Teams OAuth resume: called by the web app after account linking to
  // resume a pending Teams conversation. Authenticated by a single-use state
  // token in the body, so it gets a strict brute-force rate limit.
  {
    name: 'webhook-teams-auth-resume',
    match: { type: 'exact', path: '/api/webhooks/teams/auth/resume' },
    policy: 'webhook',
    rateLimit: { limit: 30, windowSeconds: 60 },
  },

  // Signature-authenticated webhook entry points. Each handler verifies the
  // provider's signature/secret before processing the delivery.
  {
    name: 'webhook-github',
    match: { type: 'prefix', path: '/api/webhooks/github' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },
  {
    name: 'webhook-gitlab',
    match: { type: 'prefix', path: '/api/webhooks/gitlab' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },
  {
    name: 'webhook-gitea',
    match: { type: 'prefix', path: '/api/webhooks/gitea' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },
  {
    name: 'webhook-ado',
    match: { type: 'prefix', path: '/api/webhooks/ado' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },
  {
    name: 'webhook-slack',
    match: { type: 'prefix', path: '/api/webhooks/slack' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },
  {
    name: 'webhook-linear',
    match: { type: 'prefix', path: '/api/webhooks/linear' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },
  {
    name: 'webhook-teams',
    match: { type: 'prefix', path: '/api/webhooks/teams' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },
  {
    name: 'webhook-telegram',
    match: { type: 'prefix', path: '/api/webhooks/telegram' },
    policy: 'webhook',
    rateLimit: WEBHOOK_RATE_LIMIT,
  },

  // Router-facing MCP endpoints: accept user auth tokens (LLM router
  // gathering context before a run exists) and task run tokens.
  {
    name: 'mcp-routing',
    match: { type: 'prefix', path: '/api/mcp-routing' },
    policy: 'authenticated',
  },

  // Worker/agent MCP surface. `mcpAuthMiddleware` and the per-integration
  // resolvers apply finer-grained token-type checks per endpoint.
  {
    name: 'mcp',
    match: { type: 'prefix', path: '/api/mcp' },
    policy: 'authenticated',
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
