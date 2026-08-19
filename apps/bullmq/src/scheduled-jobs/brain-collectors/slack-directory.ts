import {
  and,
  db,
  eq,
  getBrainSyncState,
  inArray,
  slackDirectoryUsers,
  slackInstallations,
} from '@roomote/db/server';
import { createSlackWebClient } from '@roomote/slack';
import { createHash } from 'node:crypto';

import type {
  BrainCollector,
  CollectorPage,
  CollectorStateUpdate,
} from './contracts';
import {
  brainSafeIdentityValue,
  LEGACY_SETUP_BOOTSTRAP_USER_ID,
  personIdentitySlug,
  type PersonIdentityReference,
} from './identity';
import { formatUtcDay } from './shared';

const LOG_PREFIX = '[brainCollectors]';

const SLACK_DIRECTORY_COLLECTOR_ID =
  'slack-person-directory:occurrence-date-v2';
const SLACK_DIRECTORY_REFRESH_MS = 24 * 60 * 60 * 1000;
const SLACK_DIRECTORY_PAGE_SIZE = 100;

export function isSlackDirectoryRefreshDue(input: {
  state: { watermark: Date | null; backfillCursor: string | null } | null;
  now: Date;
}): boolean {
  const { state, now } = input;

  return (
    !state ||
    Boolean(state.backfillCursor) ||
    !state.watermark ||
    now.getTime() - state.watermark.getTime() >= SLACK_DIRECTORY_REFRESH_MS
  );
}

export type SlackDirectoryProfile = {
  slackUserId: string;
  slackTeamId: string;
  slackTeamName: string;
  username: string | null;
  displayName: string | null;
  realName: string | null;
  title: string | null;
  isDeleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
  profileUpdatedAt: Date | null;
  firstKnownAt: Date;
};

type RawSlackDirectoryUser = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  updated?: number;
  profile?: {
    display_name?: string;
    real_name?: string;
    title?: string;
  };
};

export function slackDirectoryPageUserIds(
  users: Array<{ id?: string }>,
): string[] {
  return [
    ...new Set(
      users
        .map((user) => user.id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

function slackDirectoryIdentityKey(teamId: string, userId: string): string {
  return `${teamId}/${userId}`;
}

function slackDirectoryPersonSlug(teamId: string, userId: string): string {
  const digest = createHash('sha256')
    .update(`slack:${teamId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
  return `people/slack-member-${digest}`;
}

export function slackDirectoryProfileFromApi(input: {
  teamId: string;
  teamName: string;
  user: RawSlackDirectoryUser;
  firstKnownAt?: Date;
  observedAt?: Date;
}): SlackDirectoryProfile | null {
  const slackUserId = input.user.id?.trim();
  if (!slackUserId) return null;

  const toOptional = (value: string | undefined) => value?.trim() || null;
  const updatedSeconds = input.user.updated;

  const profileUpdatedAt =
    typeof updatedSeconds === 'number' && Number.isFinite(updatedSeconds)
      ? new Date(updatedSeconds * 1000)
      : null;
  const firstKnownAt = [input.firstKnownAt, profileUpdatedAt, input.observedAt]
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  if (!firstKnownAt) return null;

  return {
    slackUserId,
    slackTeamId: input.teamId,
    slackTeamName: input.teamName,
    username: toOptional(input.user.name),
    displayName: toOptional(input.user.profile?.display_name),
    realName: toOptional(input.user.profile?.real_name ?? input.user.real_name),
    title: toOptional(input.user.profile?.title),
    isDeleted: input.user.deleted === true,
    isBot: input.user.is_bot === true,
    isAppUser: input.user.is_app_user === true,
    profileUpdatedAt,
    firstKnownAt,
  };
}

export function isSlackHumanProfile(
  profile: SlackDirectoryProfile,
  botUserId: string,
): boolean {
  return (
    !profile.isBot &&
    !profile.isAppUser &&
    profile.slackUserId !== botUserId &&
    profile.slackUserId !== 'USLACKBOT'
  );
}

function slackDirectoryDisplayName(profile: SlackDirectoryProfile): string {
  return (
    brainSafeIdentityValue(profile.displayName ?? '') ||
    brainSafeIdentityValue(profile.realName ?? '') ||
    brainSafeIdentityValue(profile.username ?? '') ||
    'Slack member'
  );
}

export function buildSlackDirectoryPersonPage(
  profile: SlackDirectoryProfile,
  canonical?: PersonIdentityReference,
): CollectorPage {
  const slug = slackDirectoryPersonSlug(
    profile.slackTeamId,
    profile.slackUserId,
  );
  const name = slackDirectoryDisplayName(profile);
  const safeWorkspace =
    brainSafeIdentityValue(profile.slackTeamName) || 'Slack workspace';
  const effectiveDate = canonical?.effectiveDate
    ? new Date(
        Math.min(
          canonical.effectiveDate.getTime(),
          profile.firstKnownAt.getTime(),
        ),
      )
    : profile.firstKnownAt;

  if (canonical) {
    return {
      slug,
      title: name,
      content: [
        '---',
        'type: person-alias',
        `canonical: ${JSON.stringify(canonical.slug)}`,
        `event_date: ${formatUtcDay(effectiveDate)}`,
        'provenance: slack-directory',
        '---',
        '',
        `# ${name}`,
        '',
        `This Slack identity belongs to [${canonical.title}](${canonical.slug}).`,
        '',
      ].join('\n'),
    };
  }

  const aliases = profile.isDeleted
    ? []
    : [profile.displayName, profile.realName, profile.username]
        .map((value) => brainSafeIdentityValue(value ?? ''))
        .filter(
          (value, index, values) => value && values.indexOf(value) === index,
        )
        .sort((a, b) => a.localeCompare(b));
  const safeTitle = brainSafeIdentityValue(profile.title ?? '');

  return {
    slug,
    title: name,
    content: [
      '---',
      'type: person',
      `aliases: ${JSON.stringify(aliases)}`,
      `status: ${profile.isDeleted ? 'deleted' : 'active'}`,
      `event_date: ${formatUtcDay(effectiveDate)}`,
      ...(safeTitle ? [`job_title: ${JSON.stringify(safeTitle)}`] : []),
      'provenance: slack-directory',
      `workspace: ${JSON.stringify(safeWorkspace)}`,
      '---',
      '',
      `# ${name}`,
      '',
      profile.isDeleted
        ? `Former member of the ${safeWorkspace} Slack workspace.`
        : `Member of the ${safeWorkspace} Slack workspace.`,
      ...(safeTitle ? ['', `Title: ${safeTitle}`] : []),
      '',
      '## Linked identities',
      '',
      `- Slack: ${profile.username ? `${brainSafeIdentityValue(profile.username)} (${profile.slackUserId})` : profile.slackUserId}`,
      '',
    ].join('\n'),
  };
}

async function loadSlackCanonicalIdentityLookup(): Promise<
  Map<string, PersonIdentityReference>
> {
  const mappings = await db.query.slackUserMappings.findMany({
    with: {
      user: { columns: { name: true, deletedAt: true, createdAt: true } },
    },
  });
  const lookup = new Map<string, PersonIdentityReference>();

  for (const mapping of mappings) {
    if (
      mapping.userId === LEGACY_SETUP_BOOTSTRAP_USER_ID ||
      mapping.user.deletedAt
    ) {
      continue;
    }
    lookup.set(
      slackDirectoryIdentityKey(mapping.slackTeamId, mapping.slackUserId),
      {
        slug: personIdentitySlug(mapping.userId),
        title: brainSafeIdentityValue(mapping.user.name) || 'Roomote member',
        effectiveDate: mapping.user.createdAt,
      },
    );
  }

  return lookup;
}

async function persistSlackDirectoryProfiles(
  profiles: SlackDirectoryProfile[],
  now: Date,
): Promise<void> {
  for (const profile of profiles) {
    await db
      .insert(slackDirectoryUsers)
      .values({
        slackUserId: profile.slackUserId,
        slackTeamId: profile.slackTeamId,
        username: profile.username,
        displayName: profile.displayName,
        realName: profile.realName,
        title: profile.title,
        isDeleted: profile.isDeleted,
        isBot: profile.isBot,
        isAppUser: profile.isAppUser,
        profileUpdatedAt: profile.profileUpdatedAt,
        lastSeenAt: now,
        updatedAt: profile.profileUpdatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: [
          slackDirectoryUsers.slackUserId,
          slackDirectoryUsers.slackTeamId,
        ],
        set: {
          username: profile.username,
          displayName: profile.displayName,
          realName: profile.realName,
          title: profile.title,
          isDeleted: profile.isDeleted,
          isBot: profile.isBot,
          isAppUser: profile.isAppUser,
          profileUpdatedAt: profile.profileUpdatedAt,
          lastSeenAt: now,
          updatedAt: profile.profileUpdatedAt ?? now,
        },
      });
  }
}

type SlackDirectoryBatch = {
  pages: CollectorPage[];
  nextSlackCursor: string | null;
};

async function readSlackDirectoryBatch(input: {
  installation: typeof slackInstallations.$inferSelect;
  slackCursor: string | null;
  limit: number;
  now: Date;
}): Promise<SlackDirectoryBatch> {
  const client = createSlackWebClient(input.installation.botAccessToken);
  const [canonical, response] = await Promise.all([
    loadSlackCanonicalIdentityLookup(),
    client.users.list({
      limit: Math.min(input.limit, SLACK_DIRECTORY_PAGE_SIZE),
      ...(input.slackCursor ? { cursor: input.slackCursor } : {}),
    }),
  ]);
  const listed = (response.members ?? []) as RawSlackDirectoryUser[];
  const pageUserIds = slackDirectoryPageUserIds(listed);

  // users.list supplies the directory and full profile shape. Refresh linked
  // Roomote identities with users.info so their canonical cards pick up the
  // freshest Slack name/title even if a paginated directory snapshot lags.
  const [existingProfiles, refreshed] = await Promise.all([
    pageUserIds.length > 0
      ? db.query.slackDirectoryUsers.findMany({
          where: and(
            eq(slackDirectoryUsers.slackTeamId, input.installation.teamId),
            inArray(slackDirectoryUsers.slackUserId, pageUserIds),
          ),
          columns: { slackUserId: true, createdAt: true },
        })
      : Promise.resolve([]),
    Promise.all(
      listed.map(async (user) => {
        if (
          !user.id ||
          !canonical.has(
            slackDirectoryIdentityKey(input.installation.teamId, user.id),
          )
        ) {
          return user;
        }
        try {
          const info = await client.users.info({ user: user.id });
          return (info.user as RawSlackDirectoryUser | undefined) ?? user;
        } catch (error) {
          console.warn(
            `${LOG_PREFIX} slack team ${input.installation.teamId}: users.info failed for a linked member; using users.list profile: ${error instanceof Error ? error.message : String(error)}`,
          );
          return user;
        }
      }),
    ),
  ]);
  const existingCreatedAt = new Map(
    existingProfiles.map((profile) => [profile.slackUserId, profile.createdAt]),
  );
  const profiles = refreshed
    .map((user) =>
      slackDirectoryProfileFromApi({
        teamId: input.installation.teamId,
        teamName: input.installation.teamName,
        user,
        firstKnownAt: user.id ? existingCreatedAt.get(user.id) : undefined,
        observedAt: input.installation.createdAt,
      }),
    )
    .filter((profile): profile is SlackDirectoryProfile => Boolean(profile));

  // Cache every directory row so a human account that later becomes a bot or
  // app user cannot continue enriching a canonical Roomote person card.
  await persistSlackDirectoryProfiles(profiles, input.now);

  const humanProfiles = profiles.filter((profile) =>
    isSlackHumanProfile(profile, input.installation.botUserId),
  );

  return {
    pages: humanProfiles.map((profile) =>
      buildSlackDirectoryPersonPage(
        profile,
        canonical.get(
          slackDirectoryIdentityKey(profile.slackTeamId, profile.slackUserId),
        ),
      ),
    ),
    nextSlackCursor: response.response_metadata?.next_cursor?.trim() || null,
  };
}

type SlackDirectoryBackfillCursor = {
  teamId: string;
  slackCursor: string | null;
};

function parseSlackDirectoryBackfillCursor(
  raw: string | null,
): SlackDirectoryBackfillCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SlackDirectoryBackfillCursor>;
    return typeof parsed.teamId === 'string'
      ? {
          teamId: parsed.teamId,
          slackCursor:
            typeof parsed.slackCursor === 'string' ? parsed.slackCursor : null,
        }
      : null;
  } catch {
    return null;
  }
}

export const slackPersonDirectoryCollector: BrainCollector = {
  id: SLACK_DIRECTORY_COLLECTOR_ID,
  displayName: 'Slack person directory',
  async isEnabled() {
    const installation = await db.query.slackInstallations.findFirst({
      columns: { id: true },
      where: eq(slackInstallations.isActive, true),
    });
    return Boolean(installation);
  },
  async collect({ now, limit }) {
    const collectorState = await getBrainSyncState(
      db,
      SLACK_DIRECTORY_COLLECTOR_ID,
    );
    if (!collectorState?.backfillCompletedAt) {
      return { pages: [], nextSince: null };
    }

    const installations = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.isActive, true));
    const pages: CollectorPage[] = [];
    const stateUpdates: CollectorStateUpdate[] = [];

    for (const installation of installations.sort((a, b) =>
      a.teamId.localeCompare(b.teamId),
    )) {
      const stateId = `${SLACK_DIRECTORY_COLLECTOR_ID}:${installation.teamId}`;
      const state = await getBrainSyncState(db, stateId);
      const lastCompletedAt =
        state?.watermark ?? collectorState.backfillCompletedAt;
      const cursor = state?.backfillCursor ?? null;

      if (!isSlackDirectoryRefreshDue({ state, now })) {
        continue;
      }
      const remaining = limit - pages.length;
      if (remaining <= 0) break;

      try {
        const batch = await readSlackDirectoryBatch({
          installation,
          slackCursor: cursor,
          limit: remaining,
          now,
        });
        pages.push(...batch.pages);
        stateUpdates.push({
          collectorId: stateId,
          watermark: batch.nextSlackCursor ? lastCompletedAt : now,
          cursor: batch.nextSlackCursor,
        });
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} slack team ${installation.teamId}: person directory refresh failed; holding its cursor: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { pages, nextSince: null, stateUpdates };
  },
  async backfill({ cursor, limit }) {
    const installations = (
      await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.isActive, true))
    ).sort((a, b) => a.teamId.localeCompare(b.teamId));
    if (installations.length === 0) {
      return { pages: [], nextCursor: null, done: true };
    }

    const parsed = parseSlackDirectoryBackfillCursor(cursor);
    const index = parsed
      ? installations.findIndex(({ teamId }) => teamId === parsed.teamId)
      : 0;
    const installation = installations[index >= 0 ? index : 0];
    if (!installation) {
      return { pages: [], nextCursor: null, done: true };
    }

    try {
      const batch = await readSlackDirectoryBatch({
        installation,
        slackCursor:
          parsed?.teamId === installation.teamId ? parsed.slackCursor : null,
        limit,
        now: new Date(),
      });
      const nextInstallation = installations[(index >= 0 ? index : 0) + 1];
      const nextCursor = batch.nextSlackCursor
        ? JSON.stringify({
            teamId: installation.teamId,
            slackCursor: batch.nextSlackCursor,
          })
        : nextInstallation
          ? JSON.stringify({
              teamId: nextInstallation.teamId,
              slackCursor: null,
            })
          : null;

      return {
        pages: batch.pages,
        nextCursor,
        done: nextCursor === null,
      };
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} slack team ${installation.teamId}: person directory backfill failed; holding its cursor: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { pages: [], nextCursor: cursor, done: false };
    }
  },
};
