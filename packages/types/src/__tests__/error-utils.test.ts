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

  it('uses the error field from generated API client errors', () => {
    expect(
      serializeError({ code: 409, error: 'Resource already exists' }),
    ).toEqual({ message: 'Resource already exists' });
  });
});
