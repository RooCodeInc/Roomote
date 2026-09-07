import { describe, expect, it } from 'vitest';

import { parseProductReleaseHistory, parseReleaseBody } from '../release-notes';

describe('parseReleaseBody', () => {
  it('parses summary, highlights, and remaining details', () => {
    const parsed = parseReleaseBody(`## 0.15.0 (2026-07-20)

Ship in-app release notices for self-host admins and all users.

### Highlights

- Admins see when an update is available
- Users get a what's-new dialog after upgrades

### Minor changes

- Add sidenav release notices
### Patch changes

- Fix a typo
`);

    expect(parsed.summary).toBe(
      'Ship in-app release notices for self-host admins and all users.',
    );
    expect(parsed.highlights).toEqual([
      'Admins see when an update is available',
      "Users get a what's-new dialog after upgrades",
    ]);
    expect(parsed.detailsMarkdown).toContain('### Minor changes');
    expect(parsed.detailsMarkdown).toContain('- Add sidenav release notices');
    expect(parsed.detailsMarkdown).not.toContain('### Highlights');
  });

  it('handles old-format bodies without summary or highlights', () => {
    const parsed = parseReleaseBody(`## 0.14.1 (2026-07-19)

### Patch changes

- Fix controller recovery scans
`);

    expect(parsed.summary).toBeNull();
    expect(parsed.highlights).toEqual([]);
    expect(parsed.detailsMarkdown).toContain('### Patch changes');
    expect(parsed.detailsMarkdown).toContain('Fix controller recovery scans');
  });

  it('treats REPLACE ME stubs as absent', () => {
    const parsed = parseReleaseBody(`## 0.15.0 (2026-07-20)

<one-sentence release summary — REPLACE ME>

### Highlights

- <highlight — REPLACE ME>

### Minor changes

- Real change
`);

    expect(parsed.summary).toBeNull();
    expect(parsed.highlights).toEqual([]);
    expect(parsed.detailsMarkdown).toContain('Real change');
  });

  it('returns empty structure for blank bodies', () => {
    expect(parseReleaseBody(null)).toEqual({
      summary: null,
      highlights: [],
      detailsMarkdown: '',
    });
  });
});

describe('parseProductReleaseHistory', () => {
  it('parses the prepended product release sections in changelog order', () => {
    const releases = parseProductReleaseHistory(`# Changelog

Release entries are prepended.

## 0.16.0 (2026-07-21)

Current release.

### Highlights

- Current highlight

## v0.15.0 (2026-07-20)

Previous release.

### Patch changes

- Previous fix
`);

    expect(releases).toEqual([
      {
        version: '0.16.0',
        summary: 'Current release.',
        highlights: ['Current highlight'],
        detailsMarkdown: '',
      },
      {
        version: '0.15.0',
        summary: 'Previous release.',
        highlights: [],
        detailsMarkdown: '### Patch changes\n\n- Previous fix',
      },
    ]);
  });
});
