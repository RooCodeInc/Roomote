import {
  hasPreviewServiceListEntries,
  shouldIncludeInPreviewServiceList,
} from './preview-port-utils';

describe('preview-port-utils', () => {
  it('treats infrastructure ports as non-user-facing', () => {
    expect(shouldIncludeInPreviewServiceList('EDITOR')).toBe(false);
    expect(shouldIncludeInPreviewServiceList('GUI')).toBe(false);
    expect(shouldIncludeInPreviewServiceList('SANDBOX_SERVER')).toBe(false);
    expect(shouldIncludeInPreviewServiceList('WEB')).toBe(true);
    expect(shouldIncludeInPreviewServiceList('API')).toBe(true);
  });

  it('normalizes case when checking infrastructure ports', () => {
    expect(shouldIncludeInPreviewServiceList('editor')).toBe(false);
    expect(shouldIncludeInPreviewServiceList('gui')).toBe(false);
    expect(shouldIncludeInPreviewServiceList('sandbox_server')).toBe(false);
    expect(shouldIncludeInPreviewServiceList('web')).toBe(true);
    expect(shouldIncludeInPreviewServiceList('api')).toBe(true);
  });

  it('keeps application ports user-facing', () => {
    expect(shouldIncludeInPreviewServiceList('DOCS')).toBe(true);
    expect(shouldIncludeInPreviewServiceList('APP')).toBe(true);
  });

  it('detects whether at least one user-facing port exists', () => {
    expect(
      hasPreviewServiceListEntries(['EDITOR', 'GUI', 'SANDBOX_SERVER']),
    ).toBe(false);
    expect(
      hasPreviewServiceListEntries(['EDITOR', 'SANDBOX_SERVER', 'WEB']),
    ).toBe(true);
    expect(
      hasPreviewServiceListEntries(['EDITOR', 'SANDBOX_SERVER', 'API']),
    ).toBe(true);
    expect(hasPreviewServiceListEntries(['EDITOR', 'DOCS'])).toBe(true);
  });
});
