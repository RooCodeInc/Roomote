import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({
  R_APP_URL: 'https://app.example.com',
}));
const appendHelpMock = vi.hoisted(() =>
  vi.fn(async (message: string) => message),
);

vi.mock('@roomote/env', () => ({
  Env: envMock,
}));
vi.mock('../../account-link-help.js', () => ({
  appendAccountLinkHelpText: appendHelpMock,
}));

import {
  buildDiscordAccountLinkFallbackInstruction,
  buildDiscordChannelAutoStartLinkMessage,
  buildDiscordLinkRequiredMessage,
} from '../account-link.js';

afterEach(() => {
  envMock.R_APP_URL = 'https://app.example.com';
  appendHelpMock.mockImplementation(async (message: string) => message);
});

describe('Discord account-link settings copy', () => {
  it('links Settings → Personal → Linked Accounts to personal settings', async () => {
    expect(buildDiscordAccountLinkFallbackInstruction()).toBe(
      'Generate a code under [Settings → Personal → Linked Accounts](https://app.example.com/settings/personal), then DM me with `/link code:<code>`.',
    );
    await expect(buildDiscordLinkRequiredMessage()).resolves.toBe(
      'Link your Discord account to Roomote before starting tasks. Generate a code under [Settings → Personal → Linked Accounts](https://app.example.com/settings/personal), then DM me with `/link code:<code>`.',
    );
    await expect(
      buildDiscordChannelAutoStartLinkMessage('ops'),
    ).resolves.toContain(
      '[Settings → Personal → Linked Accounts](https://app.example.com/settings/personal)',
    );
  });

  it('appends deployment help to full link prompts', async () => {
    appendHelpMock.mockImplementation(
      async (message: string) => `${message} Ask an admin for an invite.`,
    );

    await expect(buildDiscordLinkRequiredMessage()).resolves.toMatch(
      /Ask an admin for an invite\.$/,
    );
    await expect(
      buildDiscordChannelAutoStartLinkMessage('ops'),
    ).resolves.toMatch(/Ask an admin for an invite\.$/);
  });

  it('falls back to bold path copy when R_APP_URL is not a valid base URL', () => {
    envMock.R_APP_URL = 'not-a-url';

    expect(buildDiscordAccountLinkFallbackInstruction()).toBe(
      'Generate a code under **Settings → Personal → Linked Accounts**, then DM me with `/link code:<code>`.',
    );
  });
});
