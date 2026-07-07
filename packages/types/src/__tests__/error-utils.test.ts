import { describe, expect, it } from 'vitest';

import { serializeError } from '../error-utils';

describe('serializeError', () => {
  it('preserves name and message from plain error-like objects', () => {
    expect(
      serializeError({
        name: 'TimeoutError',
        message: 'The operation was aborted due to timeout',
      }),
    ).toEqual({
      name: 'TimeoutError',
      message: 'The operation was aborted due to timeout',
    });
  });
});
