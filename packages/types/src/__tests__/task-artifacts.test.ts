import { describe, expect, it } from 'vitest';

import { isTextArtifactContentType } from '../task-artifacts';

describe('isTextArtifactContentType', () => {
  it.each([
    'text/plain',
    'text/markdown; charset=utf-8',
    'application/json',
    'application/vnd.api+json; charset=utf-8',
    'application/xhtml+xml',
  ])('accepts supported text MIME type %s', (contentType) => {
    expect(isTextArtifactContentType(contentType)).toBe(true);
  });

  it.each(['application/vnd.api+jsonish', 'application/octet-stream'])(
    'rejects a near-miss or binary MIME type %s',
    (contentType) => {
      expect(isTextArtifactContentType(contentType)).toBe(false);
    },
  );
});
