/**
 * Brain (gbrain) client provisioning and access-token minting over
 * gbrain's admin HTTP API. Verified against gbrain 0.45.10.0:
 *
 * - POST /admin/login {token} -> Set-Cookie gbrain_admin (bootstrap token is
 *   exchanged for a cookie session; the token itself is never persisted).
 * - POST /admin/api/register-client (cookie) {name, scopes, grantTypes}
 *   -> {clientId, clientSecret}. Scopes are enforced server-side: 'read'
 *   cannot call write verbs or /ingest.
 * - POST /admin/api/revoke-client (cookie) {clientId} -> revokes live tokens
 *   and soft-deletes the client (used when re-provisioning).
 * - POST /token client_credentials form -> {access_token, expires_in} for
 *   short-lived bearer tokens minted from stored client credentials.
 */

import { readFileSync } from 'node:fs';

import {
  and,
  db,
  eq,
  isNull,
  mcpConnections,
  resetBrainIngestionState,
} from '@roomote/db/server';
import { decrypt, encrypt } from '@roomote/db/encryption';
import { Env, isBrainConfigured } from '@roomote/env';
import {
  BRAIN_MCP_ID,
  isMcpConnectionGbrainConfig,
  type McpConnectionGbrainConfig,
} from '@roomote/types';

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

async function adminLogin(
  baseUrl: string,
  adminToken: string,
): Promise<string> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: adminToken }),
  });

  if (!response.ok) {
    throw new Error(
      `Brain admin login failed (${response.status}). Check the URL and admin bootstrap token.`,
    );
  }

  const setCookie = response.headers.get('set-cookie');
  const match = setCookie?.match(/gbrain_admin=([^;]+)/);

  if (!match) {
    throw new Error('Brain admin login did not return a session cookie.');
  }

  return `gbrain_admin=${match[1]}`;
}

async function registerClient(
  baseUrl: string,
  cookie: string,
  name: string,
  scopes: string,
): Promise<{ clientId: string; clientSecret: string }> {
  const response = await fetch(
    `${normalizeBaseUrl(baseUrl)}/admin/api/register-client`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name,
        scopes,
        grantTypes: ['client_credentials'],
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Brain client registration failed for '${name}' (${response.status} ${body.slice(0, 200)})`,
    );
  }

  const payload = (await response.json()) as {
    clientId?: string;
    clientSecret?: string;
  };

  if (!payload.clientId || !payload.clientSecret) {
    throw new Error(
      `Brain client registration for '${name}' returned no credentials.`,
    );
  }

  return { clientId: payload.clientId, clientSecret: payload.clientSecret };
}

export type ProvisionedGbrainClients = {
  agent: { clientId: string; clientSecret: string };
  ingest: { clientId: string; clientSecret: string };
  maintenance: { clientId: string; clientSecret: string };
};

/**
 * Register Roomote's three credential classes against a gbrain server:
 * a read-only agent client, a write-capable ingest client, and an
 * admin-scoped maintenance client. The admin
 * bootstrap token is used transiently for the session and never stored.
 * Previously provisioned clients (when re-connecting) should be revoked by
 * the caller via revokeGbrainClient, best-effort.
 */
export async function provisionGbrainClients(
  baseUrl: string,
  adminToken: string,
): Promise<ProvisionedGbrainClients> {
  const cookie = await adminLogin(baseUrl, adminToken);

  const agent = await registerClient(baseUrl, cookie, 'roomote-agent', 'read');
  const ingest = await registerClient(
    baseUrl,
    cookie,
    'roomote-ingest',
    'read write',
  );
  const maintenance = await registerClient(
    baseUrl,
    cookie,
    'roomote-maintenance',
    'admin',
  );

  return { agent, ingest, maintenance };
}

/** Best-effort revocation of a previously provisioned client. */
export async function revokeGbrainClient(
  baseUrl: string,
  adminToken: string,
  clientId: string,
): Promise<void> {
  try {
    const cookie = await adminLogin(baseUrl, adminToken);

    await fetch(`${normalizeBaseUrl(baseUrl)}/admin/api/revoke-client`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ clientId }),
    });
  } catch (error) {
    console.warn(
      `[brain] best-effort client revocation failed for ${clientId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

type CachedToken = { accessToken: string; expiresAtMs: number };

const tokenCache = new Map<string, CachedToken>();

/**
 * Mint (with in-process caching) a short-lived access token for a stored
 * gbrain client via the client_credentials grant. Tokens live ~1h upstream;
 * the cache refreshes with a safety margin.
 */
export async function mintGbrainAccessToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const cacheKey = `${normalizeBaseUrl(baseUrl)}::${clientId}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    tokenCache.delete(cacheKey);
    const body = await response.text().catch(() => '');
    throw new Error(
      `Brain token mint failed (${response.status} ${body.slice(0, 200)})`,
    );
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    throw new Error('Brain token mint returned no access token.');
  }

  const ttlMs = (payload.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAtMs: Date.now() + Math.max(ttlMs - TOKEN_REFRESH_MARGIN_MS, 60_000),
  });

  return payload.access_token;
}

/**
 * Resolve a usable Brain connection for one credential class, provisioning
 * headlessly the first time. There is no Settings UI: a deployment with
 * a Brain provider key has a Brain, and Roomote registers its own
 * scoped OAuth clients using gbrain's admin bootstrap token (supplied
 * directly or as a file the compose profile mounts from the brain volume).
 * The provisioned client credentials are cached in mcpConnections as pure
 * server state — no user ever sees or enters them.
 *
 * `R_GBRAIN_AGENT_TOKEN` / `R_GBRAIN_INGEST_TOKEN` remain an operator escape
 * hatch: static tokens win over provisioning when present.
 */
export async function resolveBrainConnection(
  role: 'agent' | 'ingest' | 'maintenance',
): Promise<{ baseUrl: string; token: string } | null> {
  if (!isBrainConfigured(Env)) {
    return null;
  }

  const baseUrl = Env.R_GBRAIN_URL;

  if (!baseUrl) {
    return null;
  }

  const staticToken = {
    agent: Env.R_GBRAIN_AGENT_TOKEN,
    ingest: Env.R_GBRAIN_INGEST_TOKEN,
    maintenance: Env.R_GBRAIN_MAINTENANCE_TOKEN,
  }[role];

  if (staticToken) {
    return { baseUrl, token: staticToken };
  }

  const stored = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, BRAIN_MCP_ID),
      isNull(mcpConnections.userId),
    ),
  });

  let config = isMcpConnectionGbrainConfig(stored?.authConfig)
    ? stored.authConfig
    : null;

  if (!config) {
    config = await provisionAndStoreBrainClients(baseUrl);
  }

  if (!config) {
    return null;
  }

  const mint = async (
    resolved: McpConnectionGbrainConfig,
  ): Promise<{ baseUrl: string; token: string }> => {
    const clientId = {
      agent: resolved.agentClientId,
      ingest: resolved.ingestClientId,
      maintenance: resolved.maintenanceClientId,
    }[role];
    const encryptedSecret = {
      agent: resolved.encryptedAgentClientSecret,
      ingest: resolved.encryptedIngestClientSecret,
      maintenance: resolved.encryptedMaintenanceClientSecret,
    }[role];

    return {
      baseUrl: resolved.url,
      token: await mintGbrainAccessToken(
        resolved.url,
        clientId,
        decrypt(encryptedSecret),
      ),
    };
  };

  try {
    return await mint(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Stored credentials can outlive the brain that issued them (the volume
    // was replaced, or the brain was restored from a backup). The clients are
    // ours to re-create, so re-provision once rather than staying broken.
    const clientGone =
      message.includes('invalid_grant') || message.includes('Client not found');

    if (!clientGone) {
      console.warn(
        `[brain] token mint failed for the ${role} client: ${message}`,
      );
      return null;
    }

    console.warn(
      '[brain] stored clients are unknown to the Brain; re-provisioning',
    );

    const reprovisioned = await provisionAndStoreBrainClients(baseUrl);

    if (!reprovisioned) {
      return null;
    }

    try {
      return await mint(reprovisioned);
    } catch (retryError) {
      console.warn(
        `[brain] token mint failed after re-provisioning: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
      );
      return null;
    }
  }
}

/** gbrain's admin bootstrap token, given directly or as a mounted file. */
function readGbrainAdminToken(): string | null {
  if (Env.R_GBRAIN_ADMIN_TOKEN) {
    return Env.R_GBRAIN_ADMIN_TOKEN;
  }

  if (Env.R_GBRAIN_ADMIN_TOKEN_FILE) {
    try {
      const token = readFileSync(Env.R_GBRAIN_ADMIN_TOKEN_FILE, 'utf8').trim();
      return token.length > 0 ? token : null;
    } catch {
      // Volume not mounted yet, or the brain has not booted and written it.
      return null;
    }
  }

  return null;
}

async function provisionAndStoreBrainClients(
  baseUrl: string,
): Promise<McpConnectionGbrainConfig | null> {
  const adminToken = readGbrainAdminToken();

  if (!adminToken) {
    console.warn(
      '[brain] no admin bootstrap token available yet; skipping provisioning this pass',
    );
    return null;
  }

  try {
    const clients = await provisionGbrainClients(baseUrl, adminToken);
    const authConfig: McpConnectionGbrainConfig = {
      type: 'gbrain',
      url: baseUrl,
      agentClientId: clients.agent.clientId,
      encryptedAgentClientSecret: encrypt(clients.agent.clientSecret),
      ingestClientId: clients.ingest.clientId,
      encryptedIngestClientSecret: encrypt(clients.ingest.clientSecret),
      maintenanceClientId: clients.maintenance.clientId,
      encryptedMaintenanceClientSecret: encrypt(
        clients.maintenance.clientSecret,
      ),
    };

    await db
      .insert(mcpConnections)
      .values({
        userId: null,
        mcpId: BRAIN_MCP_ID,
        connectionRole: 'default',
        authConfig,
        enabled: true,
        authStatus: 'authenticated',
      })
      .onConflictDoUpdate({
        target: [
          mcpConnections.userId,
          mcpConnections.mcpId,
          mcpConnections.connectionRole,
        ],
        set: {
          authConfig,
          enabled: true,
          authStatus: 'authenticated',
          updatedAt: new Date(),
        },
      });

    // Provisioning is also how Roomote detects a recreated gbrain database:
    // the old OAuth clients disappear with the corpus. Its ingestion
    // checkpoints live in Roomote's Postgres database, so reset them here or
    // the fresh Brain would incorrectly skip completed backfills.
    await resetBrainIngestionState(db);

    console.log('[brain] provisioned scoped clients for the Brain');

    return authConfig;
  } catch (error) {
    console.warn(
      `[brain] provisioning failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
