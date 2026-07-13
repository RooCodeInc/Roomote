export const ADO_CLOUD_BASE_URL = 'https://dev.azure.com';
export const ADO_PAT_DOCUMENTATION_URL =
  'https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops';

const ADO_CLOUD_ORGANIZATION_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,47}[A-Za-z0-9])?$/;
const ADO_SERVER_COLLECTION_FORBIDDEN_CHARACTERS = '\\/:*?"<>;#${},+=[]|';

export function normalizeAdoOrganization(organization: string): string {
  return organization.trim().replace(/^\/+|\/+$/g, '');
}

export function getAdoBaseUrlValidationError(baseUrl: string): string | null {
  const normalizedBaseUrl = baseUrl.trim();

  if (!normalizedBaseUrl) {
    return null;
  }

  try {
    const url = new URL(normalizedBaseUrl);

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return 'Enter a valid HTTP or HTTPS Azure DevOps Server URL.';
    }
  } catch {
    return 'Enter a valid HTTP or HTTPS Azure DevOps Server URL.';
  }

  return null;
}

export function isAdoCloudBaseUrl(baseUrl: string): boolean {
  const normalizedBaseUrl = baseUrl.trim();

  if (!normalizedBaseUrl) {
    return true;
  }

  try {
    const url = new URL(normalizedBaseUrl);
    return (
      url.origin === ADO_CLOUD_BASE_URL &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function getAdoOrganizationValidationError(
  organization: string,
  baseUrl = '',
): string | null {
  const normalizedOrganization = normalizeAdoOrganization(organization);

  if (!normalizedOrganization) {
    return 'Enter your Azure DevOps organization.';
  }

  if (isAdoCloudBaseUrl(baseUrl)) {
    return ADO_CLOUD_ORGANIZATION_PATTERN.test(normalizedOrganization)
      ? null
      : 'Use only letters, numbers, and hyphens, start and end with a letter or number, and use fewer than 50 characters.';
  }

  if (
    normalizedOrganization.length > 64 ||
    Array.from(normalizedOrganization).some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        ADO_SERVER_COLLECTION_FORBIDDEN_CHARACTERS.includes(character),
    ) ||
    normalizedOrganization.startsWith('_') ||
    normalizedOrganization.startsWith('.') ||
    normalizedOrganization.endsWith('.') ||
    normalizedOrganization.includes('..')
  ) {
    return 'Enter a valid Azure DevOps Server project collection name.';
  }

  return null;
}

export function buildAdoPersonalAccessTokenUrl(
  organization: string,
): string | null {
  const normalizedOrganization = normalizeAdoOrganization(organization);

  if (getAdoOrganizationValidationError(normalizedOrganization) !== null) {
    return null;
  }

  return `${ADO_CLOUD_BASE_URL}/${normalizedOrganization}/_usersSettings/tokens`;
}
