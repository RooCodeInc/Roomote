import {
  db,
  discordUserMappings,
  getBrainSyncState,
  githubUserMappings,
  slackDirectoryUsers,
  slackUserMappings,
  sourceControlUserMappings,
  teamsUserMappings,
  telegramUserMappings,
  users,
} from '@roomote/db/server';
import { createHash } from 'node:crypto';

import type {
  BrainCollector,
  CollectorPage,
  CollectorResult,
} from './contracts';
import {
  brainSafeIdentityValue,
  LEGACY_SETUP_BOOTSTRAP_USER_ID,
  normalizeIdentityAlias,
  personIdentityAliases,
  personIdentityDisplayName,
  personIdentitySlug,
  type PersonIdentityProvider,
  type PersonIdentityRecord,
  type PersonIdentityReference,
} from './identity';
import { formatUtcDay } from './shared';

export function buildPersonIdentityPage(
  record: PersonIdentityRecord,
): CollectorPage {
  const deleted = Boolean(record.deletedAt);
  const name = personIdentityDisplayName(record);
  const aliases = deleted ? [] : personIdentityAliases(record);
  const providers = deleted
    ? []
    : [...record.providers]
        .filter(({ identifier }) => brainSafeIdentityValue(identifier))
        .sort(
          (a, b) =>
            a.provider.localeCompare(b.provider) ||
            a.identifier.localeCompare(b.identifier),
        );
  const jobTitle = providers
    .map(({ title }) => brainSafeIdentityValue(title ?? ''))
    .find(Boolean);

  return {
    slug: personIdentitySlug(record.userId),
    title: name,
    content: [
      '---',
      'type: person',
      `aliases: ${JSON.stringify(aliases)}`,
      `status: ${deleted ? 'deleted' : 'active'}`,
      `event_date: ${formatUtcDay(record.createdAt)}`,
      ...(jobTitle ? [`job_title: ${JSON.stringify(jobTitle)}`] : []),
      'provenance: roomote-person-identities',
      '---',
      '',
      `# ${name}`,
      '',
      deleted
        ? 'This former Roomote member is no longer active.'
        : `Roomote deployment member with the ${record.role} role.`,
      `Joined Roomote on ${formatUtcDay(record.createdAt)}.`,
      ...(providers.length > 0
        ? [
            '',
            '## Linked identities',
            '',
            ...providers.map(({ provider, identifier, display, title }) => {
              const safeProvider = brainSafeIdentityValue(provider);
              const safeIdentifier = brainSafeIdentityValue(identifier);
              const safeDisplay = display
                ? brainSafeIdentityValue(display)
                : '';
              const safeTitle = title ? brainSafeIdentityValue(title) : '';
              return `- ${safeProvider}: ${safeDisplay ? `${safeDisplay} (${safeIdentifier})` : safeIdentifier}${safeTitle ? ` — ${safeTitle}` : ''}`;
            }),
          ]
        : []),
      '',
    ].join('\n'),
  };
}

export function buildPersonIdentityLookup(
  records: PersonIdentityRecord[],
): Map<string, PersonIdentityReference> {
  const lookup = new Map<string, PersonIdentityReference>();

  for (const record of [...records].sort((a, b) =>
    a.userId.localeCompare(b.userId),
  )) {
    if (record.deletedAt) continue;
    const reference = {
      slug: personIdentitySlug(record.userId),
      title: personIdentityDisplayName(record),
      effectiveDate: record.createdAt,
    };

    // Email is an internal linking hint for meeting attendees, not Brain page
    // content. It never leaves this process through the person-card projection.
    for (const alias of [...personIdentityAliases(record), record.email]) {
      const normalized = normalizeIdentityAlias(alias);
      if (normalized && !lookup.has(normalized)) {
        lookup.set(normalized, reference);
      }
    }
  }

  return lookup;
}

function latestIdentityUpdate(record: PersonIdentityRecord): Date {
  return record.providers.reduce(
    (latest, provider) =>
      provider.updatedAt > latest ? provider.updatedAt : latest,
    record.deletedAt && record.deletedAt > record.updatedAt
      ? record.deletedAt
      : record.updatedAt,
  );
}

export async function loadPersonIdentityRecords(): Promise<
  PersonIdentityRecord[]
> {
  const [
    memberRows,
    slackRows,
    githubRows,
    sourceControlRows,
    telegramRows,
    discordRows,
    teamsRows,
    slackDirectoryRows,
  ] = await Promise.all([
    db.select().from(users),
    db.select().from(slackUserMappings),
    db.select().from(githubUserMappings),
    db.select().from(sourceControlUserMappings),
    db.select().from(telegramUserMappings),
    db.select().from(discordUserMappings),
    db.select().from(teamsUserMappings),
    db.select().from(slackDirectoryUsers),
  ]);
  const byUserId = new Map<string, PersonIdentityRecord>(
    memberRows
      .filter((member) => member.id !== LEGACY_SETUP_BOOTSTRAP_USER_ID)
      .map((member) => [
        member.id,
        {
          userId: member.id,
          name: member.name,
          email: member.email,
          role: member.role,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
          deletedAt: member.deletedAt,
          providers: [],
        },
      ]),
  );
  const addProvider = (userId: string, provider: PersonIdentityProvider) => {
    byUserId.get(userId)?.providers.push(provider);
  };
  const slackDirectoryByIdentity = new Map(
    slackDirectoryRows.map((profile) => [
      `${profile.slackTeamId}/${profile.slackUserId}`,
      profile,
    ]),
  );

  for (const row of slackRows) {
    const cachedProfile = slackDirectoryByIdentity.get(
      `${row.slackTeamId}/${row.slackUserId}`,
    );
    const profile =
      cachedProfile &&
      !cachedProfile.isBot &&
      !cachedProfile.isAppUser &&
      cachedProfile.slackUserId !== 'USLACKBOT'
        ? cachedProfile
        : undefined;
    addProvider(row.userId, {
      provider: 'Slack',
      identifier: row.slackUserId,
      display:
        profile?.displayName ??
        profile?.realName ??
        profile?.username ??
        byUserId.get(row.userId)?.name,
      title: profile?.title,
      updatedAt:
        profile?.profileUpdatedAt && profile.profileUpdatedAt > row.updatedAt
          ? profile.profileUpdatedAt
          : row.updatedAt,
    });
  }
  for (const row of githubRows) {
    addProvider(row.userId, {
      provider: 'GitHub',
      identifier: row.githubLogin,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of sourceControlRows) {
    addProvider(row.userId, {
      provider: row.sourceControlProvider,
      identifier: row.username ?? row.externalAccountId,
      display: row.displayName,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of telegramRows) {
    addProvider(row.userId, {
      provider: 'Telegram',
      identifier: row.telegramUsername ?? row.telegramUserId,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of discordRows) {
    addProvider(row.userId, {
      provider: 'Discord',
      identifier: row.discordUsername ?? row.discordUserId,
      display: row.discordGlobalName,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of teamsRows) {
    addProvider(row.userId, {
      provider: 'Microsoft Teams',
      identifier: row.teamsAadObjectId ?? row.teamsUserId,
      updatedAt: row.updatedAt,
    });
  }

  return [...byUserId.values()];
}
const PERSON_IDENTITIES_STATE_ID =
  'person-identities:members:occurrence-date-v2';
const PERSON_IDENTITIES_RECONCILIATION_MS = 24 * 60 * 60 * 1000;
const GRANOLA_MEETINGS_COLLECTOR_ID = 'granola-meetings:entity-timeline-v3';

type PersonIdentityCursor = {
  mode: 'idle' | 'sweep' | 'incremental';
  lastSweepAt: string | null;
  projectionHash: string | null;
  afterUserId?: string;
  afterUpdatedAt?: string;
};

function parsePersonIdentityCursor(raw: string | null): PersonIdentityCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersonIdentityCursor>;
      if (
        parsed.mode === 'idle' ||
        parsed.mode === 'sweep' ||
        parsed.mode === 'incremental'
      ) {
        return {
          mode: parsed.mode,
          lastSweepAt:
            typeof parsed.lastSweepAt === 'string' ? parsed.lastSweepAt : null,
          projectionHash:
            typeof parsed.projectionHash === 'string'
              ? parsed.projectionHash
              : null,
          ...(typeof parsed.afterUserId === 'string'
            ? { afterUserId: parsed.afterUserId }
            : {}),
          ...(typeof parsed.afterUpdatedAt === 'string'
            ? { afterUpdatedAt: parsed.afterUpdatedAt }
            : {}),
        };
      }
    } catch {
      // Restart with a full idempotent sweep if the cursor is unreadable.
    }
  }

  return { mode: 'sweep', lastSweepAt: null, projectionHash: null };
}

function serializePersonIdentityCursor(cursor: PersonIdentityCursor): string {
  return JSON.stringify(cursor);
}

function personIdentityProjectionHash(records: PersonIdentityRecord[]): string {
  const projection = [...records]
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .map((record) => ({
      userId: record.userId,
      name: record.name,
      email: record.email,
      role: record.role,
      deletedAt: record.deletedAt?.toISOString() ?? null,
      providers: [...record.providers]
        .sort(
          (a, b) =>
            a.provider.localeCompare(b.provider) ||
            a.identifier.localeCompare(b.identifier) ||
            (a.display ?? '').localeCompare(b.display ?? ''),
        )
        .map(({ provider, identifier, display, title }) => ({
          provider,
          identifier,
          display: display ?? null,
          title: title ?? null,
        })),
    }));

  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

export function selectPersonIdentityBatch(input: {
  records: PersonIdentityRecord[];
  state: { watermark: Date | null; cursor: string | null } | null;
  now: Date;
  limit: number;
}): {
  records: PersonIdentityRecord[];
  watermark: Date;
  cursor: string;
  projectionChanged: boolean;
} {
  const { records, state, now, limit } = input;
  const cursor = parsePersonIdentityCursor(state?.cursor ?? null);
  const projectionHash = personIdentityProjectionHash(records);
  const projectionChanged = cursor.projectionHash !== projectionHash;
  const lastSweepAt = cursor.lastSweepAt ? new Date(cursor.lastSweepAt) : null;
  const sweepDue =
    !lastSweepAt ||
    Number.isNaN(lastSweepAt.getTime()) ||
    now.getTime() - lastSweepAt.getTime() >=
      PERSON_IDENTITIES_RECONCILIATION_MS;

  if (cursor.mode === 'sweep' || sweepDue || projectionChanged) {
    const afterUserId =
      cursor.mode === 'sweep' && !projectionChanged ? cursor.afterUserId : '';
    const candidates = [...records]
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .filter((record) => record.userId > (afterUserId ?? ''));
    const batch = candidates.slice(0, limit);
    const last = batch.at(-1);
    const hasMore = candidates.length > batch.length;

    return {
      records: batch,
      watermark: hasMore ? (state?.watermark ?? new Date(0)) : now,
      projectionChanged,
      cursor: serializePersonIdentityCursor(
        hasMore && last
          ? {
              mode: 'sweep',
              lastSweepAt: cursor.lastSweepAt,
              projectionHash,
              afterUserId: last.userId,
            }
          : {
              mode: 'idle',
              lastSweepAt: now.toISOString(),
              projectionHash,
            },
      ),
    };
  }

  const incrementalCursor = cursor.mode === 'incremental' ? cursor : null;
  const afterUpdatedAt = incrementalCursor?.afterUpdatedAt
    ? new Date(incrementalCursor.afterUpdatedAt)
    : (state?.watermark ?? new Date(0));
  const afterUserId = incrementalCursor?.afterUserId ?? '';
  const candidates = records
    .filter((record) => {
      const updatedAt = latestIdentityUpdate(record);
      return (
        updatedAt > afterUpdatedAt ||
        (incrementalCursor &&
          updatedAt.getTime() === afterUpdatedAt.getTime() &&
          record.userId > afterUserId)
      );
    })
    .sort(
      (a, b) =>
        latestIdentityUpdate(a).getTime() - latestIdentityUpdate(b).getTime() ||
        a.userId.localeCompare(b.userId),
    );
  const batch = candidates.slice(0, limit);
  const last = batch.at(-1);
  const hasMore = candidates.length > batch.length;

  return {
    records: batch,
    watermark: hasMore ? afterUpdatedAt : now,
    projectionChanged,
    cursor: serializePersonIdentityCursor(
      hasMore && last
        ? {
            mode: 'incremental',
            lastSweepAt: cursor.lastSweepAt,
            projectionHash,
            afterUpdatedAt: latestIdentityUpdate(last).toISOString(),
            afterUserId: last.userId,
          }
        : {
            mode: 'idle',
            lastSweepAt: cursor.lastSweepAt,
            projectionHash,
          },
    ),
  };
}

export const personIdentitiesCollector: BrainCollector = {
  id: 'person-identities',
  displayName: 'Roomote member identities',
  async isEnabled() {
    return true;
  },
  async collect({ now, limit }) {
    const state = await getBrainSyncState(db, PERSON_IDENTITIES_STATE_ID);
    const batch = selectPersonIdentityBatch({
      records: await loadPersonIdentityRecords(),
      state: state
        ? {
            watermark: state.watermark,
            cursor: state.backfillCursor,
          }
        : null,
      now,
      limit,
    });

    return {
      pages: batch.records.map(buildPersonIdentityPage),
      nextSince: null,
      stateUpdates: [
        {
          collectorId: PERSON_IDENTITIES_STATE_ID,
          watermark: batch.watermark,
          cursor: batch.cursor,
        },
        ...(batch.projectionChanged
          ? [
              {
                collectorId: GRANOLA_MEETINGS_COLLECTOR_ID,
                cursor: null,
                backfillCompletedAt: null,
              },
            ]
          : []),
      ],
    };
  },
};
