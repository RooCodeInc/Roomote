import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  count,
  db,
  deploymentMcpEnablements,
  deploymentSettings,
  eq,
  max,
  mcpConnections,
  repositories,
  slackInstallations,
  sql,
  taskRuns,
  teamsInstallations,
  telegramUserMappings,
} from '@roomote/db/server';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getRedis, REDIS_KEYS } from '@roomote/redis';
import {
  ANONYMOUS_ANALYTICS_METADATA_KEY,
  isAnonymousAnalyticsEnabledFromMetadata,
} from '@roomote/feature-flags';
import { getFeatureFlagEvaluator } from '@roomote/feature-flags/server';
import { isTelemetryEnvAllowed } from '@roomote/telemetry/server';

import type { UserAuthSuccess } from '@/types';
import { Env, getWebRuntimeEnvDiagnostics } from '@/lib/server/env';
import { getS3Client } from '@/lib/server/s3-client';

import { assertAdmin } from '../setup/shared';

const DEFAULT_DEPLOYMENT_ID = 'default';
const CONTROLLER_STALE_THRESHOLD_MS = 90_000;
const WORKER_STALE_THRESHOLD_MS = 120_000;

type DiagnosticsStatus = 'yes' | 'no' | 'unknown' | 'not configured';

type DeploymentDiagnosticsSection = {
  title: string;
  items: { label: string; value: string }[];
};

export type DeploymentDiagnostics = {
  generatedAt: string;
  sections: DeploymentDiagnosticsSection[];
  plainText: string;
};

export type DeploymentBuildInfo = {
  /** RELEASE_VERSION baked into the deployment, when available. */
  version: string | null;
  /** Git commit SHA from Vercel/GitHub deploy metadata, when available. */
  gitCommitSha: string | null;
};

export type MiscSettings = {
  /** The admin-controlled opt-out setting (default: enabled). */
  anonymousAnalyticsEnabled: boolean;
  /**
   * Whether this environment can send telemetry at all. False in
   * development or when no release version is baked in; the setting is
   * still editable so it applies once the deployment runs a real release.
   */
  telemetryEnvAllowed: boolean;
  /** Subtle version / commit display for the Deployment settings footer. */
  build: DeploymentBuildInfo;
  diagnostics: DeploymentDiagnostics;
};

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

async function readDeploymentMetadata(): Promise<Record<string, unknown>> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  return normalizeMetadata(settings?.metadata);
}

function formatStatus(value: DiagnosticsStatus): string {
  switch (value) {
    case 'yes':
      return 'Yes';
    case 'no':
      return 'No';
    case 'not configured':
      return 'Not configured';
    case 'unknown':
      return 'Unknown';
  }
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'None detected';
}

function present(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function isDefaultCredentialDetected(): boolean {
  return (
    Env.DASHBOARD_PASSWORD === 'roomote-local-admin' ||
    Env.ENCRYPTION_KEY === 'local-roomote-encryption-key-0001' ||
    Env.ARTIFACT_SIGNING_KEY === 'local-roomote-artifact-signing-key-1' ||
    Env.S3_ACCESS_KEY_ID === 'roomote' ||
    Env.S3_SECRET_ACCESS_KEY === 'roomote-local-artifacts-password'
  );
}

function getMissingRequiredEnvVars(): string[] {
  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'R_APP_URL',
    'TRPC_URL',
    'DASHBOARD_PASSWORD',
    'ENCRYPTION_KEY',
    'ARTIFACT_SIGNING_KEY',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET_ARTIFACTS',
  ];

  return required.filter((name) => !present(process.env[name]));
}

function hasPublicUrlCallbackMismatch(): DiagnosticsStatus {
  const publicUrl = Env.R_PUBLIC_URL ?? Env.R_APP_URL;
  const callbackUrls = [
    Env.SLACK_REDIRECT_URI,
    Env.R_LINEAR_REDIRECT_URI,
    Env.R_TEAMS_BOT_TOKEN_ENDPOINT,
  ].filter(present);

  if (!present(publicUrl) || callbackUrls.length === 0) {
    return 'unknown';
  }

  try {
    const publicHost = new URL(publicUrl ?? '').host;
    return callbackUrls.some((url) => new URL(url ?? '').host !== publicHost)
      ? 'yes'
      : 'no';
  } catch {
    return 'unknown';
  }
}

function hasWebhookSecretConfigured(): DiagnosticsStatus {
  return [
    Env.R_GITHUB_WEBHOOK_SECRET,
    Env.GITLAB_WEBHOOK_SECRET,
    Env.GITLAB_WEBHOOK_SIGNING_TOKEN,
    Env.R_SLACK_SIGNING_SECRET,
    Env.R_TELEGRAM_WEBHOOK_SECRET,
    Env.R_LINEAR_WEBHOOK_SECRET,
  ].some(present)
    ? 'yes'
    : 'no';
}

function parsePnpmVersion(): string {
  const userAgent = process.env.npm_config_user_agent;
  const pnpmMatch = userAgent?.match(/pnpm\/([^ ]+)/);
  return pnpmMatch?.[1] ?? 'Unknown';
}

function parseDockerImageTag(image: string): string {
  const tag = image.split(':').at(-1);
  return tag && tag !== image ? tag : 'Unknown';
}

async function safeFetchStatus(
  url: string | null | undefined,
): Promise<DiagnosticsStatus> {
  if (!present(url)) {
    return 'not configured';
  }

  try {
    const healthUrl = new URL('/health', url ?? '');
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok ? 'yes' : 'no';
  } catch {
    return 'no';
  }
}

async function getControllerHeartbeatStatus(): Promise<DiagnosticsStatus> {
  try {
    const lastHeartbeat = await getRedis().get(REDIS_KEYS.CONTROLLER_HEARTBEAT);
    if (!lastHeartbeat) {
      return 'unknown';
    }
    const timestamp = Number.parseInt(lastHeartbeat, 10);
    if (!Number.isFinite(timestamp)) {
      return 'unknown';
    }
    return Date.now() - timestamp <= CONTROLLER_STALE_THRESHOLD_MS
      ? 'yes'
      : 'no';
  } catch {
    return 'unknown';
  }
}

async function getWorkerHeartbeatStatus(): Promise<DiagnosticsStatus> {
  try {
    const [row] = await db
      .select({ latestHeartbeatAt: max(taskRuns.workerHeartbeatAt) })
      .from(taskRuns);
    const latestHeartbeatAt = row?.latestHeartbeatAt;

    if (!latestHeartbeatAt) {
      return 'unknown';
    }

    return Date.now() - latestHeartbeatAt.getTime() <= WORKER_STALE_THRESHOLD_MS
      ? 'yes'
      : 'no';
  } catch {
    return 'unknown';
  }
}

async function getDatabaseDiagnostics(): Promise<{
  reachable: DiagnosticsStatus;
  time: string;
}> {
  try {
    const result = (await db.execute(
      sql`select now()::text as database_time`,
    )) as Array<{ database_time: string }>;

    return {
      reachable: 'yes',
      time: result[0]?.database_time ?? 'Unknown',
    };
  } catch {
    return {
      reachable: 'no',
      time: 'Unknown',
    };
  }
}

async function getMigrationDiagnostics() {
  try {
    const result = (await db.execute(
      sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`,
    )) as Array<{ hash: string | null; created_at: string | Date | null }>;
    const current = result[0]?.hash ?? 'None detected';

    return {
      status: 'Applied',
      current,
      pending: 'Unknown',
    };
  } catch {
    return {
      status: 'Unknown',
      current: 'Unknown',
      pending: 'Unknown',
    };
  }
}

async function getObjectStorageWritableStatus(): Promise<DiagnosticsStatus> {
  const key = `diagnostics/write-check-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.txt`;

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: Env.S3_BUCKET_ARTIFACTS,
        Key: key,
        Body: 'ok',
        ContentType: 'text/plain',
      }),
    );
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: Env.S3_BUCKET_ARTIFACTS,
        Key: key,
      }),
    );
    return 'yes';
  } catch {
    return 'no';
  }
}

async function getProviderDiagnostics() {
  const [
    settings,
    slackActive,
    teamsActive,
    telegramMappings,
    sourceControlProviders,
    deploymentMcps,
    userMcps,
  ] = await Promise.all([
    db.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
      columns: { runtimeComputeConfig: true },
    }),
    db
      .select({ total: count() })
      .from(slackInstallations)
      .where(eq(slackInstallations.isActive, true)),
    db
      .select({ total: count() })
      .from(teamsInstallations)
      .where(eq(teamsInstallations.isActive, true)),
    db.select({ total: count() }).from(telegramUserMappings),
    db
      .selectDistinct({ provider: repositories.sourceControlProvider })
      .from(repositories)
      .where(eq(repositories.isActive, true)),
    db
      .select({ mcpId: deploymentMcpEnablements.mcpId })
      .from(deploymentMcpEnablements)
      .where(eq(deploymentMcpEnablements.enabled, true)),
    db
      .selectDistinct({ mcpId: mcpConnections.mcpId })
      .from(mcpConnections)
      .where(eq(mcpConnections.enabled, true)),
  ]);

  const comms: string[] = [];
  if ((slackActive[0]?.total ?? 0) > 0 || present(Env.SLACK_APP_ID)) {
    comms.push('slack');
  }
  if ((teamsActive[0]?.total ?? 0) > 0 || present(Env.R_TEAMS_BOT_APP_ID)) {
    comms.push('teams');
  }
  if (
    (telegramMappings[0]?.total ?? 0) > 0 ||
    present(Env.R_TELEGRAM_BOT_TOKEN)
  ) {
    comms.push('telegram');
  }

  return {
    comms,
    sourceControl: sourceControlProviders
      .map((row) => row.provider)
      .filter(Boolean)
      .map(String)
      .sort(),
    mcpCount: new Set([
      ...deploymentMcps.map((row) => row.mcpId),
      ...userMcps.map((row) => row.mcpId),
    ]).size,
    computeProvider:
      settings?.runtimeComputeConfig?.defaultProvider ??
      Env.DEFAULT_COMPUTE_PROVIDER,
  };
}

function buildPlainTextReport(sections: DeploymentDiagnosticsSection[]) {
  return sections
    .map((section) => {
      const lines = [
        `# ${section.title}`,
        ...section.items.map((item) => `${item.label}: ${item.value}`),
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

function tryReadRootPackageVersion(): string | null {
  try {
    // Web runtime cwd is typically apps/web; monorepo root is two levels up.
    const candidates = [
      join(process.cwd(), 'package.json'),
      join(process.cwd(), '..', '..', 'package.json'),
    ];

    for (const candidate of candidates) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      const version = parsed.version?.trim();
      if (parsed.name === 'roomote' && version) {
        return version;
      }
    }
  } catch {
    // Ignore missing package metadata; version stays null for the footer.
  }

  return null;
}

const rootPackageVersion = tryReadRootPackageVersion();

function getDeploymentBuildInfo(): DeploymentBuildInfo {
  const version = Env.RELEASE_VERSION?.trim() || rootPackageVersion || null;
  const gitCommitSha =
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    null;

  return { version, gitCommitSha };
}

async function collectDeploymentDiagnostics(): Promise<DeploymentDiagnostics> {
  const generatedAt = new Date().toISOString();
  const runtimeDiagnostics = getWebRuntimeEnvDiagnostics();
  const databaseDiagnostics = await getDatabaseDiagnostics();
  const [
    migrationDiagnostics,
    apiReachable,
    previewProxyReachable,
    controllerHeartbeat,
    workerHeartbeat,
    objectStorageWritable,
    providers,
  ] = await Promise.all([
    getMigrationDiagnostics(),
    safeFetchStatus(Env.TRPC_URL),
    safeFetchStatus(Env.PREVIEW_PROXY_BASE_URL),
    getControllerHeartbeatStatus(),
    getWorkerHeartbeatStatus(),
    getObjectStorageWritableStatus(),
    getProviderDiagnostics(),
  ]);

  const sections: DeploymentDiagnosticsSection[] = [
    {
      title: 'Instance',
      items: [
        { label: 'Generated at', value: generatedAt },
        { label: 'Roomote version', value: Env.RELEASE_VERSION ?? 'Unknown' },
        {
          label: 'Git commit',
          value:
            process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
            process.env.GITHUB_SHA?.trim() ||
            'Unknown',
        },
        {
          label: 'Docker image tag',
          value: parseDockerImageTag(Env.DOCKER_WORKER_IMAGE),
        },
        { label: 'Deployment mode', value: runtimeDiagnostics.appEnv },
      ],
    },
    {
      title: 'Runtime',
      items: [
        { label: 'Node version', value: process.version },
        { label: 'pnpm version', value: parsePnpmVersion() },
        { label: 'OS', value: process.platform },
        { label: 'Architecture', value: process.arch },
        {
          label: 'Containerized',
          value: formatStatus(
            process.env.KUBERNETES_SERVICE_HOST ? 'yes' : 'unknown',
          ),
        },
        {
          label: 'Timezone',
          value: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Unknown',
        },
      ],
    },
    {
      title: 'Services',
      items: [
        { label: 'Web reachable', value: formatStatus('yes') },
        { label: 'API reachable', value: formatStatus(apiReachable) },
        {
          label: 'Controller heartbeat',
          value: formatStatus(controllerHeartbeat),
        },
        { label: 'Worker heartbeat', value: formatStatus(workerHeartbeat) },
        {
          label: 'Preview proxy reachable',
          value: formatStatus(previewProxyReachable),
        },
        {
          label: 'Database reachable',
          value: formatStatus(databaseDiagnostics.reachable),
        },
        {
          label: 'Redis reachable',
          value: formatStatus(
            controllerHeartbeat === 'unknown' ? 'unknown' : 'yes',
          ),
        },
        {
          label: 'Object storage reachable',
          value: formatStatus(objectStorageWritable),
        },
      ],
    },
    {
      title: 'Database',
      items: [
        { label: 'Provider', value: 'PostgreSQL' },
        { label: 'Migration status', value: migrationDiagnostics.status },
        { label: 'Current migration', value: migrationDiagnostics.current },
        { label: 'Pending migrations', value: migrationDiagnostics.pending },
        { label: 'Database time', value: databaseDiagnostics.time },
      ],
    },
    {
      title: 'Compute',
      items: [
        { label: 'Compute provider', value: providers.computeProvider },
        { label: 'Sandbox provider', value: providers.computeProvider },
        {
          label: 'Snapshot support',
          value: ['daytona', 'e2b', 'modal'].includes(providers.computeProvider)
            ? 'Supported'
            : 'Unknown',
        },
        {
          label: 'Artifact storage writable',
          value: formatStatus(objectStorageWritable),
        },
      ],
    },
    {
      title: 'Integrations',
      items: [
        {
          label: 'Communications providers configured',
          value: formatList(providers.comms),
        },
        {
          label: 'Source control providers enabled',
          value: formatList(providers.sourceControl),
        },
        {
          label: 'MCP servers configured',
          value: String(providers.mcpCount),
        },
      ],
    },
    {
      title: 'Configuration Warnings',
      items: [
        {
          label: 'Missing required env vars',
          value: formatList(getMissingRequiredEnvVars()),
        },
        {
          label: 'Suspicious public URL/callback mismatch',
          value: formatStatus(hasPublicUrlCallbackMismatch()),
        },
        {
          label: 'Webhook secret configured',
          value: formatStatus(hasWebhookSecretConfigured()),
        },
        {
          label: 'Encryption key configured',
          value: formatStatus(present(Env.ENCRYPTION_KEY) ? 'yes' : 'no'),
        },
        {
          label: 'Default credentials detected',
          value: formatStatus(isDefaultCredentialDetected() ? 'yes' : 'no'),
        },
      ],
    },
  ];

  return {
    generatedAt,
    sections,
    plainText: buildPlainTextReport(sections),
  };
}

export async function getMiscSettingsCommand(
  auth: UserAuthSuccess,
): Promise<MiscSettings> {
  assertAdmin(auth);

  const metadata = await readDeploymentMetadata();
  const diagnostics = await collectDeploymentDiagnostics();

  return {
    anonymousAnalyticsEnabled:
      isAnonymousAnalyticsEnabledFromMetadata(metadata),
    telemetryEnvAllowed: isTelemetryEnvAllowed(),
    build: getDeploymentBuildInfo(),
    diagnostics,
  };
}

export async function setAnonymousAnalyticsCommand(
  auth: UserAuthSuccess,
  input: { enabled: boolean },
): Promise<MiscSettings> {
  assertAdmin(auth);

  const existingSettings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  const nextMetadata: Record<string, unknown> = {
    ...normalizeMetadata(existingSettings?.metadata),
    [ANONYMOUS_ANALYTICS_METADATA_KEY]: input.enabled,
  };

  if (!existingSettings) {
    await db.insert(deploymentSettings).values({
      id: DEFAULT_DEPLOYMENT_ID,
      metadata: nextMetadata,
      setupCompletedAt: null,
    });
  } else {
    await db
      .update(deploymentSettings)
      .set({ metadata: nextMetadata, updatedAt: new Date() })
      .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID));
  }

  // Keep the Redis-cached deployment metadata coherent for any evaluator
  // consumers, mirroring the experimental feature-flag update path.
  await getFeatureFlagEvaluator(getRedis()).invalidateDeploymentCache();

  return {
    anonymousAnalyticsEnabled:
      isAnonymousAnalyticsEnabledFromMetadata(nextMetadata),
    telemetryEnvAllowed: isTelemetryEnvAllowed(),
    build: getDeploymentBuildInfo(),
    diagnostics: await collectDeploymentDiagnostics(),
  };
}
