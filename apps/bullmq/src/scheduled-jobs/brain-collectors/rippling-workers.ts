import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  getBrainSyncState,
  isNull,
  listBrainCollectorItems,
  listBrainCollectorItemsBefore,
  mcpConnections,
} from '@roomote/db/server';
import { ripplingApiRequestJson } from '@roomote/sdk/server/rippling-api';
import {
  isMcpConnectionRipplingConfig,
  type McpConnectionRipplingConfig,
} from '@roomote/types';
import { createHash } from 'node:crypto';

import type {
  BrainCollector,
  CollectorItemUpdate,
  CollectorPage,
  CollectorResult,
} from './contracts';
import {
  brainSafeIdentityValue,
  normalizeIdentityAlias,
  type PersonIdentityReference,
} from './identity';
import {
  buildPersonIdentityLookup,
  loadPersonIdentityRecords,
} from './person-identities';
import { asString, parseDate } from './shared';

/**
 * Rippling: authoritative employee directory
 * -------------------------------------------
 *
 * Rippling's V2 workers endpoint is cursor paginated but Worker Changes is a
 * separately entitled API product. Use complete, resumable snapshots here so
 * every installation gets correct lifecycle handling without assuming that
 * optional entitlement. Reconciliation starts only after the final page.
 */

const RIPPLING_WORKERS_COLLECTOR_ID = 'rippling-workers';
const RIPPLING_SNAPSHOT_STATE_ID = `${RIPPLING_WORKERS_COLLECTOR_ID}:snapshot`;
const RIPPLING_WORKER_EXPANSIONS =
  'user,manager,manager.user,department,employment_type,teams';

type RipplingObject = Record<string, unknown>;

type RipplingWorker = RipplingObject & {
  id?: unknown;
  status?: unknown;
  work_email?: unknown;
  user?: unknown;
  manager_id?: unknown;
  manager?: unknown;
  title?: unknown;
  department_id?: unknown;
  department?: unknown;
  teams?: unknown;
  employment_type_id?: unknown;
  employment_type?: unknown;
  location?: unknown;
  start_date?: unknown;
  end_date?: unknown;
};

type RipplingWorkersResponse = {
  results?: unknown;
  next_link?: unknown;
};

type RipplingSnapshotCursor =
  | { mode: 'idle'; lastCompletedAt: string | null }
  | { mode: 'scan'; startedAt: string; nextLink: string | null }
  | { mode: 'reconcile'; startedAt: string };

function asObject(value: unknown): RipplingObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RipplingObject)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const resolved = asString(value);
    if (resolved) return resolved;
  }
  return null;
}

function ripplingDisplayName(worker: RipplingWorker): string {
  const user = asObject(worker.user);
  const name = asObject(user?.name);
  const displayName = firstString(
    name?.display_name,
    name?.preferred_name,
    user?.display_name,
  );
  if (displayName) return brainSafeIdentityValue(displayName);

  const joined = [
    firstString(name?.given_name, user?.given_name),
    firstString(name?.family_name, user?.family_name),
  ]
    .filter(Boolean)
    .join(' ');
  return brainSafeIdentityValue(joined) || 'Rippling worker';
}

function ripplingWorkEmail(worker: RipplingWorker): string | null {
  return firstString(worker.work_email, asObject(worker.user)?.work_email);
}

function ripplingWorkerId(worker: RipplingWorker): string | null {
  return firstString(worker.id);
}

function ripplingWorkerSlug(workerId: string): string {
  const digest = createHash('sha256')
    .update(workerId)
    .digest('hex')
    .slice(0, 16);
  return `people/rippling-worker-${digest}`;
}

type RipplingMembership = {
  type: 'department' | 'team';
  id: string | null;
  name: string;
};

function ripplingNamedObject(
  value: unknown,
  fallbackId: unknown,
): { id: string | null; name: string } | null {
  const object = asObject(value);
  const id = firstString(object?.id, fallbackId);
  const name = firstString(object?.name, object?.label, object?.display_name);
  if (!name && !id) return null;
  return { id, name: brainSafeIdentityValue(name ?? id ?? '') };
}

function ripplingMemberships(worker: RipplingWorker): RipplingMembership[] {
  const memberships: RipplingMembership[] = [];
  const department = ripplingNamedObject(
    worker.department,
    worker.department_id,
  );
  if (department?.name) {
    memberships.push({ type: 'department', ...department });
  }

  if (Array.isArray(worker.teams)) {
    for (const teamValue of worker.teams) {
      const team = ripplingNamedObject(teamValue, null);
      if (team?.name) memberships.push({ type: 'team', ...team });
    }
  }

  return memberships.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  );
}

function ripplingEmploymentType(worker: RipplingWorker): string | null {
  const employmentType = asObject(worker.employment_type);
  return firstString(
    employmentType?.label,
    employmentType?.name,
    employmentType?.type,
    worker.employment_type_id,
  );
}

function ripplingLocation(worker: RipplingWorker): string | null {
  const location = asObject(worker.location);
  if (!location) return firstString(worker.location);

  const type = firstString(location.type);
  const name = firstString(
    location.name,
    location.label,
    location.work_location_name,
    location.work_location_id,
  );
  return (
    [type, name]
      .filter(Boolean)
      .map((value) => brainSafeIdentityValue(value!))
      .join(' — ') || null
  );
}

export function parseRipplingWorkersResponse(payload: unknown): {
  workers: RipplingWorker[];
  nextLink: string | null;
} {
  const response = asObject(payload) as RipplingWorkersResponse | null;
  if (!response || !Array.isArray(response.results)) {
    throw new Error(
      'Rippling workers response did not contain a results array',
    );
  }

  const workers = response.results.map((worker, index) => {
    const object = asObject(worker) as RipplingWorker | null;
    if (!object || !ripplingWorkerId(object)) {
      throw new Error(
        `Rippling workers response contained an invalid worker at index ${index}`,
      );
    }
    return object;
  });

  return {
    workers,
    nextLink: firstString(response.next_link),
  };
}

export function parseRipplingSnapshotCursor(
  value: string | null,
): RipplingSnapshotCursor {
  if (!value) return { mode: 'idle', lastCompletedAt: null };
  try {
    const parsed = JSON.parse(value) as Partial<RipplingSnapshotCursor>;
    if (
      parsed.mode === 'scan' &&
      firstString(parsed.startedAt) &&
      (parsed.nextLink === null || typeof parsed.nextLink === 'string')
    ) {
      return {
        mode: 'scan',
        startedAt: parsed.startedAt!,
        nextLink: parsed.nextLink ?? null,
      };
    }
    if (parsed.mode === 'reconcile' && firstString(parsed.startedAt)) {
      return { mode: 'reconcile', startedAt: parsed.startedAt! };
    }
    if (
      parsed.mode === 'idle' &&
      (parsed.lastCompletedAt === null ||
        typeof parsed.lastCompletedAt === 'string')
    ) {
      return {
        mode: 'idle',
        lastCompletedAt: parsed.lastCompletedAt ?? null,
      };
    }
  } catch {
    // A malformed cursor safely restarts a complete snapshot.
  }
  return { mode: 'idle', lastCompletedAt: null };
}

function serializeRipplingSnapshotCursor(
  cursor: RipplingSnapshotCursor,
): string {
  return JSON.stringify(cursor);
}

type RipplingPersonReference = {
  slug: string;
  title: string;
};

function ripplingManagerReference(
  worker: RipplingWorker,
  identities: Map<string, PersonIdentityReference>,
): RipplingPersonReference | null {
  const manager = asObject(worker.manager) as RipplingWorker | null;
  const managerId = firstString(worker.manager_id, manager?.id);
  if (!managerId) return null;

  const managerEmail = manager ? ripplingWorkEmail(manager) : null;
  const canonical = managerEmail
    ? identities.get(normalizeIdentityAlias(managerEmail))
    : null;
  return canonical
    ? { slug: canonical.slug, title: canonical.title }
    : {
        slug: ripplingWorkerSlug(managerId),
        title: manager ? ripplingDisplayName(manager) : 'Manager',
      };
}

export function buildRipplingWorkerPage(input: {
  worker: RipplingWorker;
  observedAt: Date;
  snapshotStartedAt: Date;
  identities?: Map<string, PersonIdentityReference>;
}): CollectorPage | null {
  const workerId = ripplingWorkerId(input.worker);
  if (!workerId) return null;

  const identities = input.identities ?? new Map();
  const name = ripplingDisplayName(input.worker);
  const workEmail = ripplingWorkEmail(input.worker);
  const canonical = workEmail
    ? identities.get(normalizeIdentityAlias(workEmail))
    : null;
  const manager = ripplingManagerReference(input.worker, identities);
  const managerId = firstString(
    input.worker.manager_id,
    asObject(input.worker.manager)?.id,
  );
  const memberships = ripplingMemberships(input.worker);
  const exactStatus = firstString(input.worker.status) ?? 'UNKNOWN';
  const active = exactStatus === 'ACTIVE';
  const title = firstString(input.worker.title);
  const employmentType = ripplingEmploymentType(input.worker);
  const location = ripplingLocation(input.worker);
  const timezone = firstString(asObject(input.worker.user)?.timezone);
  const startDate = firstString(input.worker.start_date);
  const endDate = firstString(input.worker.end_date);
  const employeeNumber = firstString(asObject(input.worker.user)?.number);
  const aliases = [name, workEmail, workerId].filter(Boolean);

  return {
    slug: ripplingWorkerSlug(workerId),
    title: name,
    content: [
      '---',
      `type: ${canonical ? 'person-alias' : 'person'}`,
      `aliases: ${JSON.stringify(active ? aliases : [])}`,
      `status: ${active ? 'active' : 'inactive'}`,
      `source_status: ${JSON.stringify(exactStatus)}`,
      `rippling_worker_id: ${JSON.stringify(workerId)}`,
      ...(employeeNumber
        ? [`employee_number: ${JSON.stringify(employeeNumber)}`]
        : []),
      ...(managerId
        ? [`rippling_manager_id: ${JSON.stringify(managerId)}`]
        : []),
      `source_authority: authoritative-hris`,
      `provenance: rippling-hris`,
      `observed_at: ${input.observedAt.toISOString()}`,
      `snapshot_started_at: ${input.snapshotStartedAt.toISOString()}`,
      ...(canonical ? [`canonical: ${JSON.stringify(canonical.slug)}`] : []),
      ...(workEmail ? [`work_email: ${JSON.stringify(workEmail)}`] : []),
      ...(title ? [`job_title: ${JSON.stringify(title)}`] : []),
      ...(employmentType
        ? [`employment_type: ${JSON.stringify(employmentType)}`]
        : []),
      ...(location ? [`location: ${JSON.stringify(location)}`] : []),
      ...(timezone ? [`timezone: ${JSON.stringify(timezone)}`] : []),
      ...(startDate ? [`start_date: ${JSON.stringify(startDate)}`] : []),
      ...(endDate ? [`end_date: ${JSON.stringify(endDate)}`] : []),
      ...(manager ? [`reports_to: ${JSON.stringify(manager.slug)}`] : []),
      `authoritative_memberships: ${JSON.stringify(memberships)}`,
      '---',
      '',
      `# ${name}`,
      '',
      ...(canonical
        ? [`Rippling identity for [${canonical.title}](${canonical.slug}).`, '']
        : []),
      '## Employment',
      '',
      `- Rippling employee ID: ${workerId}`,
      ...(employeeNumber ? [`- Employee number: ${employeeNumber}`] : []),
      `- Status: ${exactStatus}`,
      ...(workEmail ? [`- Work email: ${workEmail}`] : []),
      ...(title ? [`- Title: ${brainSafeIdentityValue(title)}`] : []),
      ...(employmentType
        ? [`- Employment type: ${brainSafeIdentityValue(employmentType)}`]
        : []),
      ...(location ? [`- Location: ${brainSafeIdentityValue(location)}`] : []),
      ...(timezone ? [`- Time zone: ${brainSafeIdentityValue(timezone)}`] : []),
      ...(startDate ? [`- Start date: ${startDate}`] : []),
      ...(endDate ? [`- End date: ${endDate}`] : []),
      '',
      '## Authoritative organization data',
      '',
      ...(manager
        ? [`- Reports to: [${manager.title}](${manager.slug})`]
        : ['- Reports to: not provided']),
      ...(memberships.length > 0
        ? memberships.map(
            (membership) =>
              `- ${membership.type === 'department' ? 'Department' : 'Team'}: ${membership.name}`,
          )
        : ['- Memberships: none provided']),
      '',
      '_Reporting and membership fields above come directly from Rippling HRIS. Collaboration-derived relationships elsewhere in Brain are inferred signals, not replacements for this source._',
      '',
    ].join('\n'),
  };
}

export function buildUnavailableRipplingWorkerPage(item: {
  itemId: string;
  slug: string;
}): CollectorPage {
  return {
    slug: item.slug,
    title: 'Unavailable Rippling worker',
    content: [
      '---',
      'type: person',
      'aliases: []',
      'status: unavailable',
      `rippling_worker_id: ${JSON.stringify(item.itemId)}`,
      'source_authority: authoritative-hris',
      'provenance: rippling-hris',
      '---',
      '',
      '# Unavailable Rippling worker',
      '',
      'This worker was absent from the latest complete Rippling roster snapshot or the integration was disconnected.',
      '',
    ].join('\n'),
  };
}

async function findRipplingConnectionConfig(): Promise<McpConnectionRipplingConfig | null> {
  const [connection, enablement] = await Promise.all([
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, 'rippling'),
        isNull(mcpConnections.userId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
      ),
    }),
    db.query.deploymentMcpEnablements.findFirst({
      where: and(
        eq(deploymentMcpEnablements.mcpId, 'rippling'),
        eq(deploymentMcpEnablements.enabled, true),
      ),
      columns: { mcpId: true },
    }),
  ]);

  return enablement && isMcpConnectionRipplingConfig(connection?.authConfig)
    ? connection.authConfig
    : null;
}

async function collectRipplingReconciliation(
  startedAt: Date,
  limit: number,
): Promise<CollectorResult> {
  const stale = await listBrainCollectorItemsBefore(
    db,
    RIPPLING_WORKERS_COLLECTOR_ID,
    startedAt,
    limit + 1,
  );
  const batch = stale.slice(0, limit);
  const complete = stale.length <= limit;

  return {
    pages: batch.map(buildUnavailableRipplingWorkerPage),
    nextSince: complete ? startedAt : null,
    itemDeletes: [
      {
        collectorId: RIPPLING_WORKERS_COLLECTOR_ID,
        itemIds: batch.map((item) => item.itemId),
      },
    ],
    stateUpdates: [
      {
        collectorId: RIPPLING_SNAPSHOT_STATE_ID,
        cursor: serializeRipplingSnapshotCursor(
          complete
            ? { mode: 'idle', lastCompletedAt: startedAt.toISOString() }
            : { mode: 'reconcile', startedAt: startedAt.toISOString() },
        ),
      },
    ],
  };
}

export function buildRipplingWorkersRequest(
  nextLink: string | null,
  limit: number,
): {
  pathOrUrl: string;
  query: { expand: string; limit?: number };
} {
  return {
    pathOrUrl: nextLink ?? 'workers/',
    query: {
      expand: RIPPLING_WORKER_EXPANSIONS,
      ...(nextLink ? {} : { limit: Math.min(100, Math.max(1, limit)) }),
    },
  };
}

async function collectRipplingWorkers(input: {
  config: McpConnectionRipplingConfig;
  now: Date;
  limit: number;
}): Promise<CollectorResult> {
  const state = await getBrainSyncState(db, RIPPLING_SNAPSHOT_STATE_ID);
  const saved = parseRipplingSnapshotCursor(state?.backfillCursor ?? null);
  if (saved.mode === 'reconcile') {
    return collectRipplingReconciliation(
      parseDate(saved.startedAt) ?? input.now,
      input.limit,
    );
  }

  const startedAt =
    saved.mode === 'scan'
      ? (parseDate(saved.startedAt) ?? input.now)
      : input.now;
  const request = buildRipplingWorkersRequest(
    saved.mode === 'scan' ? saved.nextLink : null,
    input.limit,
  );
  const response = await ripplingApiRequestJson<unknown>({
    config: input.config,
    ...request,
  });
  const batch = parseRipplingWorkersResponse(response);
  const identities = buildPersonIdentityLookup(
    await loadPersonIdentityRecords(),
  );
  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];

  for (const worker of batch.workers) {
    const page = buildRipplingWorkerPage({
      worker,
      identities,
      observedAt: input.now,
      snapshotStartedAt: startedAt,
    });
    const workerId = ripplingWorkerId(worker);
    if (!page || !workerId) {
      throw new Error('Rippling worker could not be projected safely');
    }
    pages.push(page);
    itemUpdates.push({
      collectorId: RIPPLING_WORKERS_COLLECTOR_ID,
      itemId: workerId,
      slug: page.slug,
      lastSeenAt: startedAt,
    });
  }

  return {
    pages,
    nextSince: null,
    itemUpdates,
    stateUpdates: [
      {
        collectorId: RIPPLING_SNAPSHOT_STATE_ID,
        cursor: serializeRipplingSnapshotCursor(
          batch.nextLink
            ? {
                mode: 'scan',
                startedAt: startedAt.toISOString(),
                nextLink: batch.nextLink,
              }
            : { mode: 'reconcile', startedAt: startedAt.toISOString() },
        ),
      },
    ],
  };
}

async function collectDisabledRipplingWorkers(
  limit: number,
): Promise<CollectorResult> {
  const tracked = await listBrainCollectorItems(
    db,
    RIPPLING_WORKERS_COLLECTOR_ID,
    limit + 1,
  );
  const batch = tracked.slice(0, limit);
  return {
    pages: batch.map(buildUnavailableRipplingWorkerPage),
    nextSince: null,
    itemDeletes: [
      {
        collectorId: RIPPLING_WORKERS_COLLECTOR_ID,
        itemIds: batch.map((item) => item.itemId),
      },
    ],
    ...(tracked.length <= limit
      ? {
          stateUpdates: [
            {
              collectorId: RIPPLING_SNAPSHOT_STATE_ID,
              cursor: serializeRipplingSnapshotCursor({
                mode: 'idle',
                lastCompletedAt: null,
              }),
            },
          ],
        }
      : {}),
  };
}

export const ripplingWorkersCollector: BrainCollector = {
  id: RIPPLING_WORKERS_COLLECTOR_ID,
  displayName: 'Rippling employee directory',
  async isEnabled() {
    const [config, tracked] = await Promise.all([
      findRipplingConnectionConfig(),
      listBrainCollectorItems(db, RIPPLING_WORKERS_COLLECTOR_ID, 1),
    ]);
    return Boolean(config || tracked.length > 0);
  },
  async collect({ now, limit }) {
    const config = await findRipplingConnectionConfig();
    return config
      ? collectRipplingWorkers({ config, now, limit })
      : collectDisabledRipplingWorkers(limit);
  },
};
