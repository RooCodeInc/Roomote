import { raceWithAbort } from '../modal/abort';

export const AZURE_CREDENTIAL_TIMEOUT_MS = 15_000;

const AZURE_CREDENTIAL_TIMEOUT_MESSAGE =
  `Azure credential acquisition timed out after ${AZURE_CREDENTIAL_TIMEOUT_MS / 1_000}s. ` +
  'If using managed identity, the controller must run in Azure with that identity assigned ' +
  '(IMDS is unreachable outside Azure); otherwise configure the service principal triple ' +
  '(AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET).';

export interface AzureCredentialOptions {
  servicePrincipal?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  };
  managedIdentityClientId?: string;
}

export interface AzureTokenCredential {
  // Matches @azure/identity TokenCredential: can resolve null when the
  // chain cannot produce a token (acquireAzureToken turns that into an
  // actionable error instead of a downstream crash).
  getToken(scope: string): Promise<{
    token: string;
    expiresOnTimestamp: number;
  } | null>;
}

/**
 * Credential selection, deterministic order: explicit service principal >
 * user-assigned managed identity > ambient chain (az login, system MI).
 * Imported lazily so test seams never touch @azure/identity.
 */
export function createAzureCredential(
  options: AzureCredentialOptions,
): Promise<AzureTokenCredential> {
  return import('@azure/identity').then(
    ({
      ClientSecretCredential,
      DefaultAzureCredential,
      ManagedIdentityCredential,
    }) => {
      if (options.servicePrincipal) {
        const { tenantId, clientId, clientSecret } = options.servicePrincipal;
        return new ClientSecretCredential(tenantId, clientId, clientSecret);
      }
      return options.managedIdentityClientId
        ? new ManagedIdentityCredential(options.managedIdentityClientId)
        : new DefaultAzureCredential();
    },
  );
}

/**
 * Fail fast with a readable error instead of hanging for minutes:
 * ManagedIdentityCredential probes the IMDS endpoint (169.254.169.254),
 * which silently blackholes on non-Azure hosts.
 */
export async function acquireAzureToken(
  credential: AzureTokenCredential,
  scope: string,
): Promise<{ token: string; expiresOnTimestamp: number }> {
  const token = await raceWithAbort({
    promise: credential.getToken(scope),
    signal: AbortSignal.timeout(AZURE_CREDENTIAL_TIMEOUT_MS),
    abortMessage: AZURE_CREDENTIAL_TIMEOUT_MESSAGE,
  });

  if (!token) {
    throw new Error(
      'Azure credential chain did not return an access token. Verify service ' +
        'principal or managed identity configuration and role assignment.',
    );
  }

  return token;
}
