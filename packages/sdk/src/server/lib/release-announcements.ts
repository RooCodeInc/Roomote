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
  | 'already_announced'
  | 'queued';

type SendReleaseAnnouncementTestResult =
  | 'sent'
  | 'no_release_notes'
  | 'no_highlights';

function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 60_000 * 2 ** Math.min(attempts, 8));
}

function neutralizeMassMentions(text: string): string {
  return text
    .replace(/@(channel|here|everyone)\b/gi, '$1')
    .replace(/<!(channel|here|everyone)>/gi, '$1');
}

function toStableMajorMinorReleaseVersion(
  version: string | null | undefined,
): string | null {
  const normalized = normalizeProductVersion(version);
  const match = normalized?.match(/^(\d+)\.(\d+)\.\d+$/);
  return match ? `${match[1]}.${match[2]}.0` : null;
}

function selectLatestStableMajorMinorRelease(
  changelogMarkdown: string,
  releaseVersion?: string,
) {
  const selectedVersion = releaseVersion
    ? toStableMajorMinorReleaseVersion(releaseVersion)
    : null;
  const releases = parseProductReleaseHistory(changelogMarkdown).filter(
    (release) =>
      toStableMajorMinorReleaseVersion(release.version) === release.version,
  );
  return selectedVersion
    ? releases.find((release) => release.version === selectedVersion)
    : releases.sort((left, right) =>
        compareProductVersions(right.version, left.version),
      )[0];
}

export function buildReleaseAnnouncement(input: {
  changelogMarkdown: string;
  releaseVersion?: string;
}): { version: string; text: string } | null {
  const release = selectLatestStableMajorMinorRelease(
    input.changelogMarkdown,
    input.releaseVersion,
  );
  if (!release) {
    const suffix = input.releaseVersion
      ? ` for ${toStableMajorMinorReleaseVersion(input.releaseVersion) ?? input.releaseVersion}`
      : '';
    throw new Error(
      `No authoritative stable major or minor release notes found${suffix}`,
    );
  }
  if (!release.summary && release.highlights.length === 0) return null;

  const releaseTag = toReleaseTag(release.version);
  const lines = [
    `**What's new in Roomote ${releaseTag}**`,
    release.summary ? neutralizeMassMentions(release.summary) : null,
    release.highlights.length > 0
      ? `**Highlights for ${release.version}**`
      : null,
    ...release.highlights.map(
      (highlight) => `- ${neutralizeMassMentions(highlight)}`,
    ),
    `[See all changes in ${releaseTag}](${RELEASES_URL}/${releaseTag})`,
  ].filter((line): line is string => Boolean(line));

  return { version: release.version, text: lines.join('\n\n') };
}

async function sendReleaseAnnouncement(input: {
  destination: ResolvedAutomationDestination;
  subject: string;
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
      subject: input.subject,
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

export async function sendReleaseAnnouncementTest(
  destination: ResolvedAutomationDestination,
  options: { changelogMarkdown?: string } = {},
): Promise<SendReleaseAnnouncementTestResult> {
  const changelog =
    options.changelogMarkdown ?? (await readFile(CHANGELOG_PATH, 'utf8'));
  let announcement: ReturnType<typeof buildReleaseAnnouncement>;
  try {
    announcement = buildReleaseAnnouncement({ changelogMarkdown: changelog });
  } catch {
    return 'no_release_notes';
  }
  if (!announcement) return 'no_highlights';

  const runId = randomUUID();
  await sendReleaseAnnouncement({
    destination,
    subject: `What's new in Roomote ${toReleaseTag(announcement.version)}`,
    text: announcement.text,
    conversationKey: `builtin-automation:release_announcements:test:${runId}`,
    idempotencyKey: `release-test:${announcement.version}:${runId}`,
  });
  return 'sent';
}

export async function recordInstalledRelease(
  version: string,
): Promise<RecordInstalledReleaseResult> {
  const installedVersion = normalizeProductVersion(version);
  const selectedReleaseVersion = toStableMajorMinorReleaseVersion(version);
  if (
    !installedVersion ||
    !isParsableProductVersion(installedVersion) ||
    !selectedReleaseVersion
  ) {
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
    const previousSelectedReleaseVersion =
      toStableMajorMinorReleaseVersion(previousVersion);
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
    if (previousSelectedReleaseVersion === selectedReleaseVersion) {
      return 'patch_baselined';
    }
    if (!enabled) {
      return 'announcement_disabled';
    }
    if (!destination) return 'no_destination';

    const [delivery] = await tx
      .insert(releaseAnnouncementDeliveries)
      .values({
        previousVersion: previousSelectedReleaseVersion ?? previousVersion,
        installedVersion: selectedReleaseVersion,
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
      })
      .returning({ id: releaseAnnouncementDeliveries.id });
    return delivery ? 'queued' : 'already_announced';
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
      const announcement = buildReleaseAnnouncement({
        changelogMarkdown: changelog,
        releaseVersion: claim.row.installedVersion,
      });
      if (announcement === null) {
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
      const providerMessageId = await sendReleaseAnnouncement({
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
        subject: `What's new in Roomote ${toReleaseTag(announcement.version)}`,
        text: announcement.text,
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
