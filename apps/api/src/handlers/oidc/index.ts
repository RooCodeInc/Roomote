import { Hono } from 'hono';

import type { Variables } from '../../types';
import {
  getSandboxOidcDiscoveryDocument,
  getSandboxOidcJwks,
  isSandboxOidcConfigured,
  SANDBOX_OIDC_METADATA_CACHE_CONTROL,
} from '@roomote/auth';

export const oidcRouter = new Hono<{ Variables: Variables }>();

function assertOidcConfigured() {
  if (!isSandboxOidcConfigured()) {
    throw new Error('Sandbox OIDC is not configured');
  }
}

oidcRouter.get('/.well-known/openid-configuration', (c) => {
  assertOidcConfigured();
  c.header('Cache-Control', SANDBOX_OIDC_METADATA_CACHE_CONTROL);
  return c.json(getSandboxOidcDiscoveryDocument());
});

oidcRouter.get('/api/oidc/jwks', (c) => {
  assertOidcConfigured();
  c.header('Cache-Control', SANDBOX_OIDC_METADATA_CACHE_CONTROL);
  return c.json(getSandboxOidcJwks());
});
