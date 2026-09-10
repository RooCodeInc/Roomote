import {
  completePendingGitHubInstallation,
  getGitHubInstallation,
  syncGitHubInstallation,
} from '@roomote/github';
import { decryptSecrets } from '@roomote/db/encryption';
import {
  and,
  db,
  eq,
  githubInstallations,
  githubPendingInstallations,
  githubUserMappings,
  environmentVariables,
  isNull,
  resolveDeploymentEnvVar,
  users,
} from '@roomote/db/server';
import {
  sendUserDirectMessageBestEffort,
  reconcileSourceControlConnectionRequests,
  getSourceControlSyncStartedAt,
} from '@roomote/sdk/server';
import { requestBrainBackfill } from '@roomote/sdk/server/request-instance-ping';
import { Env } from '@roomote/env';

import type { WebhookResponse } from '../../types';

import type { WebhookInstallationCreated } from './types';

function buildInstallationApprovedMessage(accountLogin: string): string {
  const setupUrl = new URL('/setup', Env.R_APP_URL).toString();

  return `Your GitHub installation request for ${accountLogin} was approved, and Roomote is now connected. Continue setup here: ${setupUrl}`;
}

export async function handleInstallationCreated(
  payload: WebhookInstallationCreated,
): Promise<WebhookResponse> {
  try {
    const startedAt = await getSourceControlSyncStartedAt('github');
    const installationId = payload.installation.id;
    const appId = Number(await resolveDeploymentEnvVar('R_GITHUB_APP_ID'));
    if (
      !Number.isSafeInteger(appId) ||
      appId <= 0 ||
      payload.installation.app_id !== appId
    )
      return { status: 'error', message: 'installation_app_mismatch' };
    // Uses this deployment's App JWT, not an installation id/account supplied
    // by the browser. GitHub rejects installations belonging to another App.
    const installation = await getGitHubInstallation(installationId);
    if (
      installation.id !== installationId ||
      installation.app_id !== appId ||
      !installation.account ||
      installation.account.id !== payload.installation.account?.id ||
      installation.suspended_at
    )
      return { status: 'error', message: 'installation_unavailable' };

    const pending = await db.query.githubPendingInstallations.findFirst({
      where: eq(githubPendingInstallations.appId, installation.account.id),
    });
    let actorUserId = pending?.requestedByUserId;
    if (!pending) {
      const [existing, sender, configuredApp] = await Promise.all([
        db.query.githubInstallations.findFirst({
          where: and(
            eq(githubInstallations.installationId, installationId),
            eq(githubInstallations.appId, appId),
          ),
          columns: { installedByUserId: true },
        }),
        payload.sender?.id
          ? db.query.githubUserMappings.findFirst({
              where: eq(githubUserMappings.githubUserId, payload.sender.id),
              columns: { userId: true },
            })
          : undefined,
        db.query.environmentVariables.findFirst({
          where: eq(environmentVariables.name, 'R_GITHUB_APP_ID'),
          columns: {
            value: true,
            lastUpdatedByUserId: true,
            createdByUserId: true,
          },
        }),
      ]);
      // For a new unlinked installer, the admin who configured this exact App
      // supplies inventory attribution only. Continuation keeps its own actor.
      const configuredBy =
        configuredApp &&
        Number(await decryptSecrets<string>(configuredApp.value)) === appId
          ? (configuredApp.lastUpdatedByUserId ?? configuredApp.createdByUserId)
          : undefined;
      for (const candidate of [
        existing?.installedByUserId,
        sender?.userId,
        configuredBy,
      ]) {
        if (!candidate) continue;
        const admin = await db.query.users.findFirst({
          where: and(
            eq(users.id, candidate),
            eq(users.role, 'admin'),
            isNull(users.deletedAt),
          ),
          columns: { id: true },
        });
        if (admin) {
          actorUserId = admin.id;
          break;
        }
      }
    } else {
      const admin = await db.query.users.findFirst({
        where: and(
          eq(users.id, actorUserId!),
          eq(users.role, 'admin'),
          isNull(users.deletedAt),
        ),
        columns: { id: true },
      });
      if (!admin) actorUserId = undefined;
    }
    if (!actorUserId)
      return { status: 'error', message: 'installation_sync_actor_required' };
    const result = pending
      ? await completePendingGitHubInstallation(installationId)
      : await syncGitHubInstallation({ userId: actorUserId, installationId });
    if (!result.success)
      return { status: 'error', message: 'installation_sync_failed' };

    // The webhook is the universal completion point for new installations
    // (pending-approval and direct installs alike): repositories just became
    // reachable, so start Memory ingestion now rather than waiting out the
    // 15-minute schedules.
    void requestBrainBackfill('github-installation-created');

    await reconcileSourceControlConnectionRequests(
      { provider: 'github' },
      {
        successfulSync: {
          startedAt,
          repositoryFullNames: result.repositories.map(
            (repository) => repository.fullName,
          ),
        },
      },
    );
    if (
      'requestedByUserId' in result &&
      typeof result.requestedByUserId === 'string'
    ) {
      // The requester was waiting on a GitHub org owner's approval; let them
      // know on whichever chat integrations they have linked.
      await sendUserDirectMessageBestEffort({
        userId: result.requestedByUserId,
        text: buildInstallationApprovedMessage(
          result.githubInstallation.accountLogin,
        ),
        logContext: 'handleInstallationCreated',
      });
    }
  } catch (error) {
    console.error(
      `[handleInstallationCreated] Failed to complete pending GitHub installation: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: 'error', message: 'installation_sync_failed' };
  }

  return { status: 'ok' };
}
