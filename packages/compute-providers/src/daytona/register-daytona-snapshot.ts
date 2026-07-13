import { Daytona } from '@daytonaio/sdk';
import { WORKER_RUNTIME_SCHEMA_TAG } from '@roomote/types';

/**
 * Default name prefix for the Roomote worker base snapshot. The suffix is
 * derived from the worker image tag so each snapshot name identifies exactly
 * one worker image build (Daytona snapshot names cannot contain colons).
 */
export const DAYTONA_WORKER_SNAPSHOT_NAME_PREFIX = 'roomote-worker';

export function deriveDaytonaWorkerSnapshotName(imageRef: string): string {
  const imageTag = imageRef.includes(':')
    ? imageRef.slice(imageRef.lastIndexOf(':') + 1)
    : 'latest';

  const sanitizedTag = imageTag.toLowerCase().replace(/[^a-z0-9._-]/g, '-');

  return `${DAYTONA_WORKER_SNAPSHOT_NAME_PREFIX}-${sanitizedTag}-${WORKER_RUNTIME_SCHEMA_TAG}`;
}

export interface RegisterDaytonaWorkerSnapshotOptions {
  apiKey: string;
  /** Custom Daytona API URL for self-hosted installs. */
  apiUrl?: string;
  /** Target region for the snapshot. */
  target?: string;
  /**
   * Registry-qualified worker image reference (e.g. `ghcr.io/...:tag`).
   * Daytona pulls this from the registry, so the image must be public or the
   * registry must be configured in the Daytona organization — snapshot
   * registration has no per-call registry credentials.
   */
  imageRef: string;
  /** Overrides `roomote-worker-<image-tag>-r<schema>`. */
  snapshotName?: string;
  onLog?: (chunk: string) => void;
}

export interface RegisteredDaytonaWorkerSnapshot {
  /** Snapshot name suitable for `DAYTONA_SNAPSHOT_NAME`. */
  snapshotName: string;
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  return message.includes('already exists') || message.includes('conflict');
}

/**
 * Registers the Roomote worker base snapshot in the authenticated Daytona
 * organization from a published worker image. Shared by the setup-time
 * provisioning flow; `snapshot.create` waits for the registration to finish
 * and streams build logs. Re-registering an existing name resolves to the
 * existing snapshot when it is usable.
 */
export async function registerDaytonaWorkerSnapshot(
  options: RegisterDaytonaWorkerSnapshotOptions,
): Promise<RegisteredDaytonaWorkerSnapshot> {
  const { apiKey, apiUrl, target, imageRef, onLog } = options;

  if (!imageRef.includes('/')) {
    throw new Error(
      `Daytona snapshot registration needs a registry-qualified worker image; got "${imageRef}"`,
    );
  }

  const snapshotName =
    options.snapshotName ?? deriveDaytonaWorkerSnapshotName(imageRef);

  console.log(
    `[registerDaytonaWorkerSnapshot] Starting ${JSON.stringify({
      imageRef,
      snapshotName,
      apiUrl: apiUrl ?? '(default)',
      target: target ?? '(default)',
    })}`,
  );

  const sdk = new Daytona({
    apiKey,
    ...(apiUrl ? { apiUrl } : {}),
    ...(target ? { target } : {}),
  });

  try {
    await sdk.snapshot.create(
      { name: snapshotName, image: imageRef },
      {
        ...(onLog ? { onLogs: onLog } : {}),
      },
    );
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }

    // A retry after a partial earlier run can hit the existing name; accept
    // it when the snapshot is usable, otherwise surface its real state.
    const existing = await sdk.snapshot.get(snapshotName);

    if (existing.state !== 'active') {
      throw new Error(
        `Daytona snapshot "${snapshotName}" already exists but is in state "${existing.state}"; delete it in Daytona and retry`,
      );
    }

    console.log(
      `[registerDaytonaWorkerSnapshot] Reusing existing active snapshot ${snapshotName}`,
    );
  }

  console.log(
    `[registerDaytonaWorkerSnapshot] Snapshot registered ${JSON.stringify({
      snapshotName,
    })}`,
  );

  return { snapshotName };
}
