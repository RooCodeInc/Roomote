import { db, eq, githubInstallations } from '@roomote/db/server';

/**
 * A public GitHub App can be installed by any account, so a validly signed
 * webhook delivery is not proof of a relationship with this deployment.
 * Events must reference an installation this deployment has already synced
 * before they are recorded or handled. `installation` creation events pass
 * through so pending installations can complete; that handler is guarded by
 * its own pending-installation record match.
 */
export async function isFromKnownInstallation(
  eventName: string,
  rawPayload: string,
): Promise<boolean> {
  let action: string | undefined;
  let installationId: number | undefined;

  try {
    const parsed: unknown = JSON.parse(rawPayload);

    if (typeof parsed !== 'object' || parsed === null) {
      return true;
    }

    const payload = parsed as {
      action?: unknown;
      installation?: { id?: unknown } | null;
    };

    action = typeof payload.action === 'string' ? payload.action : undefined;
    installationId =
      typeof payload.installation?.id === 'number'
        ? payload.installation.id
        : undefined;
  } catch {
    // Defer malformed payloads to verifyAndReceive's own error handling.
    return true;
  }

  if (eventName === 'installation' && action === 'created') {
    return true;
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
