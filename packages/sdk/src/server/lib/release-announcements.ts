import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  and,
  db,
  deploymentSettings,
  eq,
  findActiveSlackInstallationForChannel,
  getBackgroundAgentSettings,
  getAutomationRuntime,
  isNull,
  lte,
  lt,
  or,
  releaseAnnouncementDeliveries,
  recordAutomationRunOutcome,
  sql,
} from '@roomote/db/server';
import {
  compareProductVersions,
  hasProductVersionMajorOrMinorChange,
  isParsableProductVersion,
  normalizeProductVersion,
  parseProductReleaseHistory,
  toReleaseTag,
} from '@roomote/types';

import { getCommunicationProviderAdapter } from './communication-providers';
import {
  findTeamsConversationServiceUrl,
  listConnectedCommunicationProviders,
  resolveAutomationRuntimeDestination,
  sendAutomationEmailReport,
  type ResolvedAutomationDestination,
} from '../automations/destination';

const DEPLOYMENT_ID = 'default';
const DELIVERY_LEASE_MS = 2 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;
const CHANGELOG_PATH = resolve(process.cwd(), '..', '..', 'CHANGELOG.md');
const RELEASES_URL = 'https://github.com/RooCodeInc/Roomote/releases/tag';

export type RecordInstalledReleaseResult =
  | 'invalid_version'
  | 'baselined'
  | 'unchanged'
  | 'rollback_baselined'
  | 'patch_baselined'
  | 'announcement_disabled'
  | 'no_destination'
  | 'queued';

type SendInstalledReleaseAnnouncementTestResult =
  | 'sent'
  | 'no_installed_release'
  | 'no_previous_release'
  | 'no_highlights';

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.min(attempts, 8));
}

function neutralizeMassMentions(text: string): string {
  return text
    .replace(/@(channel|here|everyone)\b/gi, '$1')
    .replace(/<!(channel|here|everyone)>/gi, '$1');
}

export function buildInstalledReleaseAnnouncement(input: {
  previousVersion: string;
  installedVersion: string;
  changelogMarkdown: string;
}): string | null {
  const releases = parseProductReleaseHistory(input.changelogMarkdown)
    .filter(
      (release) =>
        compareProductVersions(release.version, input.previousVersion) > 0 &&
        compareProductVersions(release.version, input.installedVersion) <= 0,
    )
    .sort((left, right) => compareProductVersions(right.version, left.version));
  if (!releases.some((release) => release.version === input.installedVersion)) {
    throw new Error(
      `No authoritative release notes found for ${input.installedVersion}`,
    );
  }

  const selected: Array<{ version: string; text: string }> = [];
  for (const release of releases) {
    const highlight = release.highlights[0];
    if (highlight) selected.push({ version: release.version, text: highlight });
    if (selected.length === 3) break;
  }
  if (selected.length < 3) {
    for (const release of releases) {
      for (const highlight of release.highlights.slice(1)) {
        selected.push({ version: release.version, text: highlight });
        if (selected.length === 3) break;
      }
      if (selected.length === 3) break;
    }
  }
  if (selected.length === 0) {
    return null;
  }

  const installedTag = toReleaseTag(input.installedVersion);
  const previousTag = toReleaseTag(input.previousVersion);
  const spansMultipleReleases = releases.length > 1;
  const highlights = selected.map(({ version, text }) => {
    const prefix = spansMultipleReleases
      ? `**${toReleaseTag(version)}:** `
      : '';
    return `- ${prefix}${neutralizeMassMentions(text)}`;
  });

  return [
    `**Roomote ${installedTag} is installed**`,
    `Updated from ${previousTag}.${spansMultipleReleases ? ` Highlights across ${releases.length} releases:` : ' Highlights:'}`,
    ...highlights,
    `[Read the full ${installedTag} release notes](${RELEASES_URL}/${installedTag})`,
  ].join('\n');
}

async function sendInstalledReleaseAnnouncement(input: {
  destination: ResolvedAutomationDestination;
  installedVersion: string;
  text: string;
  conversationKey: string;
  idempotencyKey: string;
}): Promise<string | null> {
  const { destination } = input;
  if (destination.provider === 'email') {
    if (!destination.userId || !destination.identityId) {
      throw new Error('Email release destination is incomplete');
    }
    await sendAutomationEmailReport(destination, {
      subject: `Roomote ${toReleaseTag(input.installedVersion)} is installed`,
      conversationKey: input.conversationKey,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });
    return null;
  }

  const slackInstallation =
    destination.provider === 'slack' && !destination.teamId
      ? await findActiveSlackInstallationForChannel(destination.channelId)
      : null;
  const slackTeamId = destination.teamId ?? slackInstallation?.teamId;
  if (destination.provider === 'slack' && !slackTeamId) {
    throw new Error('No unambiguous active Slack installation for channel');
  }
  const adapter = await getCommunicationProviderAdapter(
    destination.provider,
    destination.provider === 'slack' ? { slackTeamId } : {},
  );
  if (!adapter) {
    throw new Error(`No active ${destination.provider} connection`);
  }
  const serviceUrl =
    destination.provider === 'teams'
      ? (destination.serviceUrl ??
        (await findTeamsConversationServiceUrl(destination.channelId)))
      : null;
  if (destination.provider === 'teams' && !serviceUrl) {
    throw new Error('No Teams service URL for destination');
  }
  const result = await adapter.postMessage({
    channelId: destination.channelId,
    text: input.text,
    textFormat: 'markdown',
    idempotencyKey: input.idempotencyKey,
    ...(serviceUrl ? { serviceUrl } : {}),
    ...(destination.provider === 'slack'
      ? { blocks: [{ type: 'markdown' as const, text: input.text }] }
      : {}),
  });
  return result.messageId;
}

export async function sendInstalledReleaseAnnouncementTest(
  destination: ResolvedAutomationDestination,
  options: { changelogMarkdown?: string } = {},
): Promise<SendInstalledReleaseAnnouncementTestResult> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEPLOYMENT_ID),
    columns: { installedReleaseVersion: true },
  });
  const installedVersion = normalizeProductVersion(
    settings?.installedReleaseVersion,
  );
  if (!installedVersion || !isParsableProductVersion(installedVersion)) {
    return 'no_installed_release';
  }

  const changelog =
    options.changelogMarkdown ?? (await readFile(CHANGELOG_PATH, 'utf8'));
  const previousVersion = parseProductReleaseHistory(changelog)
    .map((release) => release.version)
    .filter((version) => compareProductVersions(version, installedVersion) < 0)
    .sort((left, right) => compareProductVersions(right, left))[0];
  if (!previousVersion) return 'no_previous_release';

  const text = buildInstalledReleaseAnnouncement({
    previousVersion,
    installedVersion,
    changelogMarkdown: changelog,
  });
  if (!text) return 'no_highlights';

  const runId = randomUUID();
  await sendInstalledReleaseAnnouncement({
    destination,
    installedVersion,
    text,
    conversationKey: `builtin-automation:release_announcements:test:${runId}`,
    idempotencyKey: `release-test:${installedVersion}:${runId}`,
  });
  return 'sent';
}

export async function recordInstalledRelease(
  version: string,
): Promise<RecordInstalledReleaseResult> {
  const installedVersion = normalizeProductVersion(version);
  if (!installedVersion || !isParsableProductVersion(installedVersion)) {
    return 'invalid_version';
  }
  const runtime = await getAutomationRuntime('release_announcements');
  const enabled = runtime.enabled && runtime.settings.optedOut !== true;
  const connectedProviders = enabled
    ? await listConnectedCommunicationProviders()
    : [];
  const destination = enabled
    ? await resolveAutomationRuntimeDestination({
        runtime,
        slackConnected: connectedProviders.includes('slack'),
      })
    : null;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('installed-release-announcement', 0))`,
    );
    await tx
      .insert(deploymentSettings)
      .values({ id: DEPLOYMENT_ID })
      .onConflictDoNothing({ target: deploymentSettings.id });

    const settings = await tx.query.deploymentSettings.findFirst({
      where: eq(deploymentSettings.id, DEPLOYMENT_ID),
      columns: {
        installedReleaseVersion: true,
      },
    });
    const previousVersion = normalizeProductVersion(
      settings?.installedReleaseVersion,
    );
    const now = new Date();

    if (!previousVersion || !isParsableProductVersion(previousVersion)) {
      await tx
        .update(deploymentSettings)
        .set({
          installedReleaseVersion: installedVersion,
          installedReleaseRecordedAt: now,
          updatedAt: now,
        })
        .where(eq(deploymentSettings.id, DEPLOYMENT_ID));
      return 'baselined';
    }

    const comparison = compareProductVersions(
      installedVersion,
      previousVersion,
    );
    if (comparison === 0) return 'unchanged';

    await tx
      .update(deploymentSettings)
      .set({
        installedReleaseVersion: installedVersion,
        installedReleaseRecordedAt: now,
        updatedAt: now,
      })
      .where(eq(deploymentSettings.id, DEPLOYMENT_ID));
    if (comparison < 0) return 'rollback_baselined';
    if (
      !hasProductVersionMajorOrMinorChange(previousVersion, installedVersion)
    ) {
      return 'patch_baselined';
    }
    if (!enabled) {
      return 'announcement_disabled';
    }
    if (!destination) return 'no_destination';

    await tx
      .insert(releaseAnnouncementDeliveries)
      .values({
        previousVersion,
        installedVersion,
        provider: destination.provider,
        destinationKey: `${destination.provider}:${destination.channelId}`,
        channelId: destination.channelId,
        serviceUrl: destination.serviceUrl ?? null,
        recipientUserId: destination.userId ?? null,
        emailIdentityId: destination.identityId ?? null,
      })
      .onConflictDoNothing({
        target: [
          releaseAnnouncementDeliveries.installedVersion,
          releaseAnnouncementDeliveries.destinationKey,
        ],
      });
    return 'queued';
  });
}

async function claimDueDelivery() {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('release-announcement-claim', 0))`,
    );
    const now = new Date();
    const row = await tx.query.releaseAnnouncementDeliveries.findFirst({
      where: and(
        eq(releaseAnnouncementDeliveries.status, 'pending'),
        lte(releaseAnnouncementDeliveries.nextAttemptAt, now),
        or(
          isNull(releaseAnnouncementDeliveries.leaseExpiresAt),
          lt(releaseAnnouncementDeliveries.leaseExpiresAt, now),
        ),
      ),
      orderBy: releaseAnnouncementDeliveries.nextAttemptAt,
    });
    if (!row) return null;

    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(releaseAnnouncementDeliveries)
      .set({
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS),
        updatedAt: now,
      })
      .where(eq(releaseAnnouncementDeliveries.id, row.id))
      .returning();
    return claimed ? { row: claimed, leaseToken } : null;
  });
}

export async function drainReleaseAnnouncementDeliveries(
  options: { changelogMarkdown?: string } = {},
): Promise<{ delivered: number; failed: number }> {
  if (!(await getBackgroundAgentSettings()).releaseAnnouncementsEnabled) {
    return { delivered: 0, failed: 0 };
  }
  let delivered = 0;
  let failed = 0;

  for (;;) {
    const claim = await claimDueDelivery();
    if (!claim) break;

    try {
      const changelog =
        options.changelogMarkdown ?? (await readFile(CHANGELOG_PATH, 'utf8'));
      const text = buildInstalledReleaseAnnouncement({
        previousVersion: claim.row.previousVersion,
        installedVersion: claim.row.installedVersion,
        changelogMarkdown: changelog,
      });
      if (text === null) {
        await db
          .update(releaseAnnouncementDeliveries)
          .set({
            status: 'skipped',
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(releaseAnnouncementDeliveries.id, claim.row.id),
              eq(releaseAnnouncementDeliveries.leaseToken, claim.leaseToken),
            ),
          );
        await recordAutomationRunOutcome(db, {
          key: 'release_announcements',
          status: 'skipped',
        });
        continue;
      }
      const providerMessageId = await sendInstalledReleaseAnnouncement({
        destination: {
          provider: claim.row.provider,
          channelId: claim.row.channelId,
          ...(claim.row.serviceUrl ? { serviceUrl: claim.row.serviceUrl } : {}),
          ...(claim.row.recipientUserId
            ? { userId: claim.row.recipientUserId }
            : {}),
          ...(claim.row.emailIdentityId
            ? { identityId: claim.row.emailIdentityId }
            : {}),
          source: 'automation_target',
        },
        installedVersion: claim.row.installedVersion,
        text,
        conversationKey: `builtin-automation:release_announcements:${claim.row.id}`,
        idempotencyKey: `release:${claim.row.installedVersion}:${claim.row.destinationKey}`,
      });
      await db
        .update(releaseAnnouncementDeliveries)
        .set({
          status: 'delivered',
          providerMessageId,
          deliveredAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(releaseAnnouncementDeliveries.id, claim.row.id),
            eq(releaseAnnouncementDeliveries.leaseToken, claim.leaseToken),
          ),
        );
      await recordAutomationRunOutcome(db, {
        key: 'release_announcements',
        status: 'succeeded',
      });
      delivered += 1;
    } catch (error) {
      const attempts = claim.row.attempts + 1;
      await db
        .update(releaseAnnouncementDeliveries)
        .set({
          attempts,
          nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 2_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(releaseAnnouncementDeliveries.id, claim.row.id),
            eq(releaseAnnouncementDeliveries.leaseToken, claim.leaseToken),
          ),
        );
      await recordAutomationRunOutcome(db, {
        key: 'release_announcements',
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      failed += 1;
    }
  }

  return { delivered, failed };
}
