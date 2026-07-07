import type { FileDiff } from '../../hooks';

import { toDiffLines } from './utils';

function buildFileDiff(lines: FileDiff['lines']): FileDiff {
  return {
    path: 'screenshots/homepage.png',
    lines,
    additions: 0,
    deletions: 0,
    isNew: true,
    isDeleted: false,
  };
}

describe('toDiffLines', () => {
  it('returns non-header lines for normal text diffs', () => {
    const file = buildFileDiff([
      { type: 'header', content: '@@ -1 +1 @@' },
      { type: 'remove', content: 'old', oldLineNumber: 1 },
      { type: 'add', content: 'new', newLineNumber: 1 },
    ]);

    expect(toDiffLines(file)).toEqual([
      { type: 'remove', content: 'old' },
      { type: 'add', content: 'new' },
    ]);
  });

  it('falls back to header lines when a file has no text diff lines', () => {
    const file = buildFileDiff([
      {
        type: 'header',
        content: 'Binary files /dev/null and b/screenshots/homepage.png differ',
      },
    ]);

    expect(toDiffLines(file)).toEqual([
      {
        type: 'context',
        content: 'Binary files /dev/null and b/screenshots/homepage.png differ',
      },
    ]);
  });
});
