vi.mock('@roomote/env', () => ({
  Env: {
    R_GITHUB_APP_SLUG: 'primary',
    R_GITHUB_ADDITIONAL_APP_SLUGS: ' extra, PRIMARY, , other ',
  },
}));

import {
  getEffectiveGitHubAppSlugs,
  parseAdditionalGitHubAppSlugs,
} from '../app-slug';

describe('parseAdditionalGitHubAppSlugs', () => {
  it('trims, normalizes, and deduplicates comma-separated slugs', () => {
    expect(
      parseAdditionalGitHubAppSlugs(' roomote-dev, , Acme,roomote-dev '),
    ).toEqual(['roomote-dev', 'acme']);
  });

  it('returns no slugs for empty or absent values', () => {
    expect(parseAdditionalGitHubAppSlugs('')).toEqual([]);
    expect(parseAdditionalGitHubAppSlugs(' , ')).toEqual([]);
    expect(parseAdditionalGitHubAppSlugs(undefined)).toEqual([]);
  });

  it('combines the effective slug with additional trusted slugs', () => {
    expect(getEffectiveGitHubAppSlugs()).toEqual(['primary', 'extra', 'other']);
  });
});
