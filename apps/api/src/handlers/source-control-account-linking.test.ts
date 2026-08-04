const { appendHelpMock, envMock } = vi.hoisted(() => ({
  appendHelpMock: vi.fn(async (message: string) => `${message} Custom help.`),
  envMock: { R_APP_URL: 'https://app.example.com' },
}));

vi.mock('@roomote/env', () => ({ Env: envMock }));
vi.mock('./account-link-help.js', () => ({
  appendAccountLinkHelpText: appendHelpMock,
}));

import { buildSourceControlAccountLinkRequiredMessage } from './source-control-account-linking';

describe('buildSourceControlAccountLinkRequiredMessage', () => {
  it('keeps provider copy and appends deployment help', async () => {
    await expect(
      buildSourceControlAccountLinkRequiredMessage('github'),
    ).resolves.toContain(
      '[Settings -> Linked Accounts](https://app.example.com/settings?service=github)',
    );
    await expect(
      buildSourceControlAccountLinkRequiredMessage('github'),
    ).resolves.toMatch(/mention me again\. Custom help\.$/);
  });

  it('keeps provider setup guidance before deployment help', async () => {
    await expect(
      buildSourceControlAccountLinkRequiredMessage('gitlab'),
    ).resolves.toMatch(
      /add the GitLab OAuth client credentials.*first\. Custom help\.$/,
    );
  });
});
