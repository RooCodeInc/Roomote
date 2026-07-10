import {
  DEFAULT_PR_REVIEW_SETTINGS,
  getRoomoteManagedGitHubLogins,
  type PrReviewSettings,
} from '@roomote/types';
import {
  type DatabaseOrTransaction,
  db,
  getReviewCodeAutomationSettings,
  isNull,
  upsertAutomation,
  users,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';
import { Env } from '@/lib/server/env';

import { assertAdmin } from './feature-gates';

export interface ReviewerRelayUser {
  userId: string;
  name: string;
  email: string | null;
  imageUrl: string | null;
  relayEnabled: boolean;
}

export interface ReviewerBackgroundAgentSettings {
  id: string;
  enabled: boolean;
  environmentScope: NonNullable<PrReviewSettings['environmentScope']>;
  environmentIds: string[];
  authorReviewMode: NonNullable<PrReviewSettings['authorReviewMode']>;
  collaboratorLogins: string[];
  excludedAuthors: string | null;
  reviewAllPullRequestAuthors: boolean;
  reviewOnCommit: boolean;
  reviewDraftPrs: boolean;
  relayReviewResultsToTask: boolean;
  relayUsers: ReviewerRelayUser[];
  approvePr: boolean;
}

const UNPROVISIONED_REVIEWER_ID = 'background-code-reviewer';

function normalizeGitHubLogins(logins: string[]): string[] {
  return [...new Set(logins.map((login) => login.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

let roomoteReviewerLogins: string[] | null = null;

function getRoomoteReviewerLogins(): string[] {
  // Keep Env access out of module evaluation so Next.js instrumentation can
  // bootstrap the Node.js runtime before server routes import this module.
  if (!roomoteReviewerLogins) {
    roomoteReviewerLogins = normalizeGitHubLogins(
      getRoomoteManagedGitHubLogins(Env.R_GITHUB_APP_SLUG),
    );
  }

  return roomoteReviewerLogins;
}

export function mapReviewerSettingsToBackgroundSettings(
  settings: PrReviewSettings,
  relayUsers: ReviewerRelayUser[],
): ReviewerBackgroundAgentSettings {
  return {
    id: UNPROVISIONED_REVIEWER_ID,
    enabled: settings.enabled ?? DEFAULT_PR_REVIEW_SETTINGS.enabled,
    environmentScope: 'all',
    environmentIds: [],
    authorReviewMode: 'specific',
    collaboratorLogins: getRoomoteReviewerLogins(),
    excludedAuthors: null,
    reviewAllPullRequestAuthors:
      settings.reviewAllPullRequestAuthors ??
      DEFAULT_PR_REVIEW_SETTINGS.reviewAllPullRequestAuthors,
    reviewOnCommit:
      settings.reviewOnCommit ?? DEFAULT_PR_REVIEW_SETTINGS.reviewOnCommit,
    reviewDraftPrs:
      settings.reviewDraftPrs ?? DEFAULT_PR_REVIEW_SETTINGS.reviewDraftPrs,
    relayReviewResultsToTask:
      settings.relayReviewResultsToTask ??
      DEFAULT_PR_REVIEW_SETTINGS.relayReviewResultsToTask,
    relayUsers,
    approvePr: settings.approvePr ?? DEFAULT_PR_REVIEW_SETTINGS.approvePr,
  };
}

export function buildDefaultReviewerSettings(
  relayUsers: ReviewerRelayUser[],
): ReviewerBackgroundAgentSettings {
  return mapReviewerSettingsToBackgroundSettings(
    DEFAULT_PR_REVIEW_SETTINGS,
    relayUsers,
  );
}

export function getRelayEligibleCreatorIds(
  settings: PrReviewSettings | null | undefined,
): string[] {
  const userIds = settings?.relayEligibleCreatorIds;

  if (!Array.isArray(userIds)) {
    return [];
  }

  return [
    ...new Set(userIds.filter((userId): userId is string => Boolean(userId))),
  ].sort((left, right) => left.localeCompare(right));
}

export async function listReviewerRelayUserRecords(
  auth: UserAuthSuccess,
  selectedUserIds: string[],
  options?: {
    enforceMembership?: boolean;
  },
): Promise<ReviewerRelayUser[]> {
  const selectedSet = new Set(selectedUserIds);
  const enforceMembership = options?.enforceMembership === true;
  const membershipUsers = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      imageUrl: users.imageUrl,
    })
    .from(users)
    .where(isNull(users.deletedAt));

  const validUserIds = new Set(membershipUsers.map(({ userId }) => userId));

  if (enforceMembership) {
    for (const userId of selectedSet) {
      if (!validUserIds.has(userId)) {
        throw new Error('Selected relay users must be active users.');
      }
    }
  }

  return membershipUsers
    .map((user) => ({
      ...user,
      relayEnabled: selectedSet.has(user.userId),
    }))
    .sort((left, right) => {
      const leftLabel = `${left.name} ${left.email ?? ''}`.trim();
      const rightLabel = `${right.name} ${right.email ?? ''}`.trim();
      return leftLabel.localeCompare(rightLabel);
    });
}

export async function clearReviewerRelayStateForDeployment(): Promise<void> {
  const currentSettings = await getReviewCodeAutomationSettings();

  await db.transaction(async (tx) => {
    await upsertAutomation(tx, {
      key: 'review_code',
      enabled: currentSettings.enabled ?? DEFAULT_PR_REVIEW_SETTINGS.enabled,
      settings: {
        ...currentSettings,
        relayReviewResultsToTask: false,
        relayEligibleCreatorIds: [],
      },
    });
  });
}

export async function ensureManagedReviewerEnabledByDefaultInTx(
  tx: DatabaseOrTransaction,
  auth: UserAuthSuccess,
): Promise<void> {
  assertAdmin(auth);
  await upsertAutomation(tx, {
    key: 'review_code',
    enabled: true,
    settings: {
      ...DEFAULT_PR_REVIEW_SETTINGS,
      enabled: true,
      approvePr: false,
    },
  });
}
