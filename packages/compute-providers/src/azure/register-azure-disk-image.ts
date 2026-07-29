import { WORKER_RUNTIME_SCHEMA_TAG } from '@roomote/types';

import { AzureDataPlaneError } from '../adapters/azure';

const API_VERSION = '2026-02-01-preview';
const DATA_PLANE_SCOPE = 'https://dynamicsessions.io/.default';

const DISK_IMAGE_POLL_INTERVAL_MS = 5_000;
const DISK_IMAGE_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Default name prefix for the Roomote worker base disk image. The suffix is
 * derived from the worker image tag so each disk image name identifies exactly
 * one worker image build (Azure disk image names cannot contain colons).
 */
export const AZURE_WORKER_DISK_IMAGE_NAME_PREFIX = 'roomote-worker';

export function deriveAzureWorkerDiskImageName(imageRef: string): string {
  const imageTag = imageRef.includes(':')
    ? imageRef.slice(imageRef.lastIndexOf(':') + 1)
    : 'latest';

  const sanitizedTag = imageTag.toLowerCase().replace(/[^a-z0-9._-]/g, '-');

  return `${AZURE_WORKER_DISK_IMAGE_NAME_PREFIX}-${sanitizedTag}-${WORKER_RUNTIME_SCHEMA_TAG}`;
}

export interface RegisterAzureDiskImageOptions {
  /** Azure subscription ID (`AZURE_SUBSCRIPTION_ID`). */
  subscriptionId: string;
  /** Resource group containing the sandbox group (`AZURE_RESOURCE_GROUP`). */
  resourceGroup: string;
  /** Sandbox group name (`AZURE_SANDBOX_GROUP`). */
  sandboxGroup: string;
  /** Data-plane region (`AZURE_SANDBOX_REGION`), e.g. `canadacentral`. */
  region: string;
  /**
   * Registry-qualified worker image reference (e.g. `ghcr.io/...:tag`).
   * Azure pulls this from the registry when baking the disk image; private
   * registries require `registryCredentials`.
   */
  imageRef: string;
  /**
   * Registry credentials for pulling private container images during the
   * bake (`registryCredentials` on the data-plane PUT). For GHCR: the GitHub
   * username that owns the token, and a PAT with `read:packages`.
   */
  registryCredentials?: { username: string; token: string };
  /** Overrides `roomote-worker-<image-tag>-r<schema>`. */
  name?: string;
  /**
   * Optional client ID of a user-assigned managed identity. When omitted,
   * auth falls back to the ambient Azure credential chain (az login locally,
   * system-assigned identity when deployed).
   */
  managedIdentityClientId?: string;
  /**
   * Service principal credentials (`AZURE_TENANT_ID` + `AZURE_CLIENT_ID` +
   * `AZURE_CLIENT_SECRET`). Preferred for containerized deployments where
   * `az login` is impractical inside the container.
   */
  servicePrincipal?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RegisteredAzureDiskImage {
  /** Disk image id suitable for `AZURE_SANDBOX_DISK_IMAGE`. */
  diskImageId: string;
}

interface AzureDiskImage {
  id?: string;
  labels?: Record<string, string>;
  status?: { state?: string; message?: string };
}

/**
 * Registers the Roomote worker base disk image in the Azure sandbox group
 * from a published worker OCI image. Shared by the setup-time provisioning
 * flow; the PUT returns immediately and the bake finishes asynchronously, so
 * the disk image is polled until its status reaches `Ready`/`Succeeded`
 * (fail on `Failed`).
 */
export async function registerAzureDiskImage(
  options: RegisterAzureDiskImageOptions,
): Promise<RegisteredAzureDiskImage> {
  const {
    subscriptionId,
    resourceGroup,
    sandboxGroup,
    region,
    imageRef,
    managedIdentityClientId,
    registryCredentials,
  } = options;

  if (!imageRef.includes('/')) {
    throw new Error(
      `Azure disk image registration needs a registry-qualified worker image; got "${imageRef}"`,
    );
  }

  const name = options.name ?? deriveAzureWorkerDiskImageName(imageRef);
  const fetchImpl = options.fetchImpl ?? fetch;

  const endpoint = `https://management.${region}.azuredevcompute.io`;
  const collectionPath =
    `/subscriptions/${subscriptionId}` +
    `/resourceGroups/${resourceGroup}` +
    `/sandboxGroups/${sandboxGroup}` +
    `/diskimages`;

  console.log(
    `[registerAzureDiskImage] Starting ${JSON.stringify({
      imageRef,
      name,
      region,
      resourceGroup,
      sandboxGroup,
    })}`,
  );

  let credentialPromise:
    | Promise<{
        getToken(scope: string): Promise<{
          token: string;
          expiresOnTimestamp: number;
        }>;
      }>
    | undefined;
  let cachedToken: { token: string; expiresOnTimestamp: number } | undefined;

  const getToken = async (): Promise<string> => {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresOnTimestamp - 5 * 60 * 1_000 > now) {
      return cachedToken.token;
    }

    if (!credentialPromise) {
      credentialPromise = import('@azure/identity').then(
        ({
          ClientSecretCredential,
          DefaultAzureCredential,
          ManagedIdentityCredential,
        }) => {
          // Same deterministic order as the adapter: explicit service
          // principal > user-assigned MI > ambient chain.
          if (options.servicePrincipal) {
            const { tenantId, clientId, clientSecret } =
              options.servicePrincipal;
            return new ClientSecretCredential(tenantId, clientId, clientSecret);
          }
          return managedIdentityClientId
            ? new ManagedIdentityCredential(managedIdentityClientId)
            : new DefaultAzureCredential();
        },
      );
    }
    const credential = await credentialPromise;
    cachedToken = await credential.getToken(DATA_PLANE_SCOPE);
    return cachedToken.token;
  };

  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    const url = new URL(`${endpoint}${path}`);
    url.searchParams.set('api-version', API_VERSION);

    const response = await fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${await getToken()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status < 400) {
      if (response.status === 204) return {};
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }

    const errorText = await response.text().catch(() => '');
    throw new AzureDataPlaneError(
      `Azure data plane ${method} ${path} failed with status ${response.status}: ${
        errorText || 'no response body'
      }`,
      response.status,
    );
  };

  const created = (await request('PUT', collectionPath, {
    image: { base: imageRef },
    labels: { name },
    ...(registryCredentials
      ? {
          registryCredentials: {
            username: registryCredentials.username,
            token: registryCredentials.token,
          },
        }
      : {}),
  })) as AzureDiskImage;

  if (!created.id) {
    throw new Error('Azure disk image registration returned no disk image id');
  }

  const deadline = Date.now() + DISK_IMAGE_POLL_TIMEOUT_MS;
  let lastLoggedState: string | undefined;
  let diskImage = created;

  while (true) {
    const state = diskImage.status?.state;

    if (state === 'Ready' || state === 'Succeeded') {
      break;
    }

    if (state === 'Failed') {
      throw new Error(
        `Azure disk image "${name}" failed to build${
          diskImage.status?.message ? `: ${diskImage.status.message}` : ''
        }`,
      );
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Azure disk image "${name}" did not become Ready within ${
          DISK_IMAGE_POLL_TIMEOUT_MS / 60_000
        } minutes (last state: ${state ?? 'unknown'})`,
      );
    }

    if (state !== lastLoggedState) {
      console.log(
        `[registerAzureDiskImage] Waiting for disk image ${JSON.stringify({
          id: created.id,
          name,
          state: state ?? 'unknown',
        })}`,
      );
      lastLoggedState = state;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, DISK_IMAGE_POLL_INTERVAL_MS),
    );
    diskImage = (await request(
      'GET',
      `${collectionPath}/${created.id}`,
    )) as AzureDiskImage;
  }

  console.log(
    `[registerAzureDiskImage] Disk image registered ${JSON.stringify({
      diskImageId: created.id,
      name,
    })}`,
  );

  return { diskImageId: created.id };
}
