import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  R_APP_URL: 'https://app.example.com',
}));

vi.mock('@roomote/env', () => ({
  Env: envMock,
}));

import {
  buildDiscordAccountLinkFallbackInstruction,
  buildDiscordChannelAutoStartLinkMessage,
  buildDiscordLinkRequiredMessage,
} from '../account-link.js';

afterEach(() => {
  envMock.R_APP_URL = 'https://app.example.com';
});

describe('Discord account-link settings copy', () => {
  it('links Settings → Personal → Linked Accounts to personal settings', () => {
    expect(buildDiscordAccountLinkFallbackInstruction()).toBe(
      'Generate a code under [Settings → Personal → Linked Accounts](https://app.example.com/settings/personal), then DM me with `/link code:<code>`.',
    );
    expect(buildDiscordLinkRequiredMessage()).toBe(
      'Link your Discord account to Roomote before starting tasks. Generate a code under [Settings → Personal → Linked Accounts](https://app.example.com/settings/personal), then DM me with `/link code:<code>`.',
    );
    expect(buildDiscordChannelAutoStartLinkMessage('ops')).toContain(
      '[Settings → Personal → Linked Accounts](https://app.example.com/settings/personal)',
    );
  });

  it('falls back to bold path copy when R_APP_URL is not a valid base URL', () => {
    envMock.R_APP_URL = 'not-a-url';

    expect(buildDiscordAccountLinkFallbackInstruction()).toBe(
      'Generate a code under **Settings → Personal → Linked Accounts**, then DM me with `/link code:<code>`.',
    );
  });
});
