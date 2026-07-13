import {
  buildAdoPersonalAccessTokenUrl,
  getAdoBaseUrlValidationError,
  getAdoOrganizationValidationError,
  isAdoCloudBaseUrl,
  normalizeAdoOrganization,
} from './ado';

describe('Azure DevOps setup helpers', () => {
  it('normalizes an organization slug', () => {
    expect(normalizeAdoOrganization(' /acme/ ')).toBe('acme');
  });

  it('builds an organization-scoped PAT URL', () => {
    expect(buildAdoPersonalAccessTokenUrl('Acme-Org')).toBe(
      'https://dev.azure.com/Acme-Org/_usersSettings/tokens',
    );
  });

  it.each([
    '',
    '   ',
    '.',
    '..',
    'acme org',
    'acme/org',
    'https://dev.azure.com/acme',
    '-acme',
    'acme-',
    'a'.repeat(50),
  ])('rejects an unsafe organization %j', (value) => {
    expect(buildAdoPersonalAccessTokenUrl(value)).toBeNull();
  });

  it('accepts Azure DevOps Server collection names only with a custom host', () => {
    expect(
      getAdoOrganizationValidationError(
        'Default Collection',
        'https://ado.example.com/tfs',
      ),
    ).toBeNull();
    expect(
      getAdoOrganizationValidationError(
        'Default Collection',
        'https://dev.azure.com',
      ),
    ).not.toBeNull();
    expect(
      getAdoOrganizationValidationError(
        'collection/name',
        'https://ado.example.com/tfs',
      ),
    ).not.toBeNull();
  });

  it('recognizes only the default cloud URL as Azure DevOps Services', () => {
    expect(isAdoCloudBaseUrl('')).toBe(true);
    expect(isAdoCloudBaseUrl('https://dev.azure.com/')).toBe(true);
    expect(isAdoCloudBaseUrl('https://dev.azure.com:444')).toBe(false);
    expect(isAdoCloudBaseUrl('https://ado.example.com/tfs')).toBe(false);
  });

  it('validates custom Azure DevOps Server URLs', () => {
    expect(
      getAdoBaseUrlValidationError('https://ado.example.com/tfs'),
    ).toBeNull();
    expect(getAdoBaseUrlValidationError('ado.example.com')).not.toBeNull();
    expect(
      getAdoBaseUrlValidationError('ftp://ado.example.com'),
    ).not.toBeNull();
    expect(
      getAdoBaseUrlValidationError('https://ado.example.com/tfs?view=mine'),
    ).not.toBeNull();
    expect(
      getAdoBaseUrlValidationError('https://ado.example.com/tfs#tokens'),
    ).not.toBeNull();
  });
});
