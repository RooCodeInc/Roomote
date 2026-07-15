import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOMOTE_CLOUD_BACKEND,
  resolveRoomoteCloudBackend,
} from '../compute-providers/roomote-cloud';

describe('resolveRoomoteCloudBackend', () => {
  it('defaults to modal when unset or blank', () => {
    expect(resolveRoomoteCloudBackend({})).toBe(DEFAULT_ROOMOTE_CLOUD_BACKEND);
    expect(resolveRoomoteCloudBackend({ ROOMOTE_CLOUD_BACKEND: '  ' })).toBe(
      DEFAULT_ROOMOTE_CLOUD_BACKEND,
    );
  });

  it('accepts a supported backend', () => {
    expect(resolveRoomoteCloudBackend({ ROOMOTE_CLOUD_BACKEND: 'modal' })).toBe(
      'modal',
    );
  });

  it('throws on an unsupported backend instead of silently falling back', () => {
    expect(() =>
      resolveRoomoteCloudBackend({ ROOMOTE_CLOUD_BACKEND: 'e2b' }),
    ).toThrow('Unsupported ROOMOTE_CLOUD_BACKEND "e2b"');
  });
});
