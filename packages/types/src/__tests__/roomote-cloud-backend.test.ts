import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOMOTE_CLOUD_BACKEND,
  resolveRoomoteCloudBackend,
  resolveRoomoteCloudModalAppName,
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

describe('resolveRoomoteCloudModalAppName', () => {
  it('maps the deployment slug to a roomote-prefixed app name', () => {
    expect(
      resolveRoomoteCloudModalAppName({ ROOMOTE_CLOUD_SLUG: 'acme' }),
    ).toBe('roomote-acme');
  });

  it('lets the dedicated ROOMOTE_CLOUD_APP_NAME override win', () => {
    expect(
      resolveRoomoteCloudModalAppName({
        ROOMOTE_CLOUD_APP_NAME: 'managed-custom-app',
        ROOMOTE_CLOUD_SLUG: 'acme',
      }),
    ).toBe('managed-custom-app');
  });

  it('ignores the BYO Modal MODAL_APP_NAME so it cannot redirect managed attribution', () => {
    expect(
      resolveRoomoteCloudModalAppName({
        MODAL_APP_NAME: 'byo-custom-app',
        ROOMOTE_CLOUD_SLUG: 'acme',
      }),
    ).toBe('roomote-acme');
  });

  it('returns undefined with neither, deferring to the client default', () => {
    expect(resolveRoomoteCloudModalAppName({})).toBeUndefined();
    expect(
      resolveRoomoteCloudModalAppName({ ROOMOTE_CLOUD_SLUG: '  ' }),
    ).toBeUndefined();
  });
});
