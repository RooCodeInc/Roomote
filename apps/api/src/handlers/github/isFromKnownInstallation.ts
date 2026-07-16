import {
  db,
  eq,
  githubInstallations,
  githubPendingInstallations,
} from '@roomote/db/server';

/**
 * A public GitHub App can be installed by any account, so a validly signed
 * webhook delivery is not proof of a relationship with this deployment.
 * Events must reference an installation this deployment has already synced
 * before they are recorded or handled. `installation` creation events are
 * instead matched against pending installations - the same check their
 * handler enforces - so installs nobody requested through this deployment
 * are dropped before they are persisted.
 */
export async function isFromKnownInstallation(
  eventName: string,
  rawPayload: string,
): Promise<boolean> {
  let action: string | undefined;
  let installationId: number | undefined;
  let accountId: number | undefined;

  try {
    const parsed: unknown = JSON.parse(rawPayload);

    if (typeof parsed !== 'object' || parsed === null) {
      return true;
    }

    const payload = parsed as {
      action?: unknown;
      installation?: { id?: unknown; account?: { id?: unknown } | null } | null;
    };

    action = typeof payload.action === 'string' ? payload.action : undefined;
    installationId =
      typeof payload.installation?.id === 'number'
        ? payload.installation.id
        : undefined;
    accountId =
      typeof payload.installation?.account?.id === 'number'
        ? payload.installation.account.id
        : undefined;
  } catch {
    // Defer malformed payloads to verifyAndReceive's own error handling.
    return true;
  }

  if (eventName === 'installation' && action === 'created') {
    if (accountId === undefined) {
      return false;
    }

    // The pending row's appId column stores the account id of the requested
    // installation target; see finishCreateGitHubInstallationCommand.
    const pendingInstallation =
      await db.query.githubPendingInstallations.findFirst({
        where: eq(githubPendingInstallations.appId, accountId),
        columns: { id: true },
      });

    return pendingInstallation !== undefined;
  }

  if (installationId === undefined) {
    // Signed events without an installation reference (for example `ping`)
    // come from GitHub for this app itself.
    return true;
  }

  const installation = await db.query.githubInstallations.findFirst({
    where: eq(githubInstallations.installationId, installationId),
    columns: { id: true },
  });

  return installation !== undefined;
}
