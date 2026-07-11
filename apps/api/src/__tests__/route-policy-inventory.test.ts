import { createApiApp } from '../server';
import { findRoutePolicyRule, ROUTE_POLICY_RULES } from '../route-policies';

/**
 * Wildcard middleware registrations that are infrastructure rather than
 * endpoints: request observability, CORS, token auth, and the route policy
 * gate itself. They cannot serve a response on their own — a request still
 * has to reach a policy-classified endpoint — so they are exempt from route
 * policy classification. Keep this list tight: adding an entry here must
 * never be the fix for an unclassified endpoint.
 */
const INFRASTRUCTURE_MIDDLEWARE_PATHS = new Set(['/*', '/api/*']);

type RegisteredRoute = {
  method: string;
  path: string;
};

function listRegisteredRoutes(): RegisteredRoute[] {
  const app = createApiApp();

  return app.routes.map((route) => ({
    method: route.method,
    path: route.path,
  }));
}

/**
 * Resolve the path a route entry exposes for policy matching. Wildcard
 * suffixes (`/foo/*`) cover requests under `/foo/`, so the static base path
 * is what must be classified.
 */
function policyLookupPath(path: string): string {
  if (path.endsWith('/*')) {
    return path.slice(0, -'/*'.length) || '/';
  }

  return path;
}

describe('route policy inventory', () => {
  it('declares a policy for every registered route', () => {
    const routes = listRegisteredRoutes();

    // Guard against the enumeration silently going stale: the API registers
    // a substantial route surface, so a near-empty listing means the
    // inventory is no longer seeing real routes.
    expect(routes.length).toBeGreaterThan(50);

    const unclassified = routes.filter((route) => {
      if (INFRASTRUCTURE_MIDDLEWARE_PATHS.has(route.path)) {
        return false;
      }

      return !findRoutePolicyRule(policyLookupPath(route.path));
    });

    expect(
      unclassified,
      'Every registered route must be covered by a rule in apps/api/src/route-policies.ts. ' +
        'Unclassified routes are rejected at runtime (default-deny), so declare a policy ' +
        `for: ${JSON.stringify(unclassified)}`,
    ).toEqual([]);
  });

  it('has no dead or fully shadowed policy rules', () => {
    const routes = listRegisteredRoutes();

    const unusedRules = ROUTE_POLICY_RULES.filter(
      (rule) =>
        !routes.some(
          (route) => findRoutePolicyRule(policyLookupPath(route.path)) === rule,
        ),
    ).map((rule) => rule.name);

    expect(
      unusedRules,
      'Every policy rule must be the first match for at least one registered route; ' +
        `remove or reorder dead rules: ${JSON.stringify(unusedRules)}`,
    ).toEqual([]);
  });

  it('keeps the infrastructure exemption list wildcard-only', () => {
    for (const path of INFRASTRUCTURE_MIDDLEWARE_PATHS) {
      expect(path.endsWith('/*') || path === '*').toBe(true);
    }
  });
});
