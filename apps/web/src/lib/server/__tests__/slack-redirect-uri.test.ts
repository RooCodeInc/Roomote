import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnvState = vi.hoisted(() => ({
  R_APP_URL: 'http://localhost:3000',
  R_PUBLIC_URL: undefined as string | undefined,
  SLACK_REDIRECT_URI: '',
}));

vi.mock('../env', () => ({
  Env: mockEnvState,
}));

import { getSlackRedirectUri } from '../slack-redirect-uri';

describe('getSlackRedirectUri', () => {
  beforeEach(() => {
    mockEnvState.R_APP_URL = 'http://localhost:3000';
    mockEnvState.R_PUBLIC_URL = undefined;
    mockEnvState.SLACK_REDIRECT_URI = '';
  });

  it('returns SLACK_REDIRECT_URI when configured', () => {
    mockEnvState.SLACK_REDIRECT_URI =
      'https://override.example.com/api/slack/callback';

    expect(getSlackRedirectUri()).toBe(
      'https://override.example.com/api/slack/callback',
    );
  });

  it('prefers R_PUBLIC_URL when SLACK_REDIRECT_URI is unset', () => {
    mockEnvState.R_PUBLIC_URL = 'https://customer.roomote.ai';

    expect(getSlackRedirectUri()).toBe(
      'https://customer.roomote.ai/api/slack/callback',
    );
  });

  it('falls back to R_APP_URL when R_PUBLIC_URL is unset', () => {
    expect(getSlackRedirectUri()).toBe(
      'http://localhost:3000/api/slack/callback',
    );
  });
});
