import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import {
  and,
  db,
  eq,
  gt,
  sql,
  taskRuns,
  sessionEgressWorkloads,
  recordTaskRunLifecycleEvent,
  terminateSessionEgressWorkload,
} from '@roomote/db/server';
import { createSessionEgressControllerClient } from '@roomote/sdk/server/session-egress';
import {
  isSessionEgressBootstrapReady,
  publishSessionEgressDelivery,
} from '@roomote/sdk/server';
import {
  activeRunStatuses,
  buildSessionEgressServiceTokenEnv,
  SESSION_EGRESS_WORKLOAD_ENV,
  type SessionProxyRegistration,
} from '@roomote/types';
import type { ComputeProviderClient } from '@roomote/compute-providers';

export interface SessionProxyConfig {
  endpoint: string;
  caBundle: string;
  apiBaseUrl: string;
}

export function resolveSessionProxyConfig(
  env: {
    SESSION_EGRESS_AUTHENTICATED_PROXY_URL?: string;
    SESSION_EGRESS_AUTHENTICATED_PROXY_CA_CERT_FILE?: string;
    TRPC_URL: string;
  },
  readFile = (path: string) => readFileSync(path, 'utf8'),
): SessionProxyConfig | null {
  const endpoint = env.SESSION_EGRESS_AUTHENTICATED_PROXY_URL;
  const caFile = env.SESSION_EGRESS_AUTHENTICATED_PROXY_CA_CERT_FILE;
  if (!endpoint && !caFile) return null;
  if (!endpoint || !caFile)
    throw new Error(
      'Authenticated Session proxy endpoint and public CA file must both be configured',
    );
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Authenticated Session proxy requires an HTTPS origin without credentials or a path',
    );
  }
  const pem = readFile(caFile);
  const certificates = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (
    !certificates?.length ||
    pem
      .replace(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
        '',
      )
      .trim()
  ) {
    throw new Error(
      'Session proxy trust file must contain public certificates only',
    );
  }
  for (const certificate of certificates) new X509Certificate(certificate);
  return {
    endpoint: url.origin,
    apiBaseUrl: env.TRPC_URL,
    caBundle: [...rootCertificates, ...certificates].join('\n'),
  };
}

/** Normal bootstrap first; this establishes logical proxy access, never forced egress. */
export async function deliverSessionProxy(input: {
  config: SessionProxyConfig;
  runId: number;
  taskId: string;
  provider: string;
  nonce: string;
  machineId: string;
  computeClient: Pick<ComputeProviderClient, 'writeFiles'>;
}) {
  const client = createSessionEgressControllerClient({
    apiBaseUrl: input.config.apiBaseUrl,
  });
  const signal = AbortSignal.timeout(20 * 60_000);
  let registration: SessionProxyRegistration | undefined;
  try {
    for (;;) {
      signal.throwIfAborted();
      const run = await db.query.taskRuns.findFirst({
        where: eq(taskRuns.id, input.runId),
        columns: { status: true, machineId: true },
      });
      if (
        !run ||
        run.machineId !== input.machineId ||
        !activeRunStatuses.some((status) => status === run.status)
      ) {
        throw new Error(
          'Session proxy bootstrap is no longer attached to an active run',
        );
      }
      if (await isSessionEgressBootstrapReady(input.runId, input.nonce)) break;
      await delay(500, undefined, { signal });
    }
    registration = await client.registerProxy({
      runId: input.runId,
      provider: input.provider,
      leaseSeconds: 900,
      capabilitySeconds: 900,
    });
    const caFile = `/tmp/roomote-session-proxy-${input.runId}.pem`;
    await input.computeClient.writeFiles({
      instanceId: input.machineId,
      files: [{ path: caFile, content: Buffer.from(input.config.caBundle) }],
      signal,
    });
    const { tokens, manifest } = buildSessionEgressServiceTokenEnv(
      registration.substitutes,
    );
    await publishSessionEgressDelivery(
      input.runId,
      registration,
      {
        [SESSION_EGRESS_WORKLOAD_ENV.ADMISSION_MODE]: 'authenticated_proxy',
        [SESSION_EGRESS_WORKLOAD_ENV.WORKLOAD_ID]: registration.workloadId,
        [SESSION_EGRESS_WORKLOAD_ENV.GENERATION]: String(
          registration.generation,
        ),
        [SESSION_EGRESS_WORKLOAD_ENV.PROXY_URL]: input.config.endpoint,
        [SESSION_EGRESS_WORKLOAD_ENV.CA_FILE]: caFile,
        [SESSION_EGRESS_WORKLOAD_ENV.SERVICES]: JSON.stringify(manifest),
        [SESSION_EGRESS_WORKLOAD_ENV.PROXY_CAPABILITY]:
          registration.proxyCapability,
        [SESSION_EGRESS_WORKLOAD_ENV.PROXY_CAPABILITY_EXPIRES_AT]:
          registration.proxyCapabilityExpiresAt,
        ...tokens,
      },
      input.nonce,
    );
    await recordTaskRunLifecycleEvent(db, {
      runId: input.runId,
      taskId: input.taskId,
      eventType: 'decision',
      message:
        'Authenticated Session proxy configuration is available for worker connection verification; unrelated egress is not restricted.',
      details: {
        stage: 'session_proxy_delivery',
        admissionMode: 'authenticated_proxy',
        generation: registration.generation,
      },
    });
  } catch {
    if (registration)
      await terminateSessionEgressWorkload(
        registration.workloadId,
        'provision_failed',
        registration.generation,
      ).catch(() => undefined);
    throw new Error(
      'Authenticated Session proxy bootstrap or delivery failed; credentials are unavailable',
    );
  }
}

/** Recovery does not need a bearer token: the controller renews only live bound rows. */
export async function renewActiveSessionProxyLeases(
  config: SessionProxyConfig,
) {
  const client = createSessionEgressControllerClient({
    apiBaseUrl: config.apiBaseUrl,
  });
  const rows = await db
    .select({
      id: sessionEgressWorkloads.id,
      generation: sessionEgressWorkloads.generation,
    })
    .from(sessionEgressWorkloads)
    .where(
      and(
        eq(sessionEgressWorkloads.admissionMode, 'authenticated_proxy'),
        eq(sessionEgressWorkloads.status, 'active'),
        gt(
          sessionEgressWorkloads.proxyCapabilityExpiresAt,
          sql`clock_timestamp()`,
        ),
      ),
    )
    .orderBy(sessionEgressWorkloads.updatedAt)
    .limit(100);
  for (const row of rows) {
    await client.renewProxyLease(row.id, row.generation).catch(() => {
      console.warn(
        '[sessionProxy] Lease not renewed; existing expiry remains authoritative',
      );
    });
  }
}
