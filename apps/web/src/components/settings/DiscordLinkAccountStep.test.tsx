import { render, screen, waitFor } from '@testing-library/react';

const { createLinkCodeMock, discordAccountMock } = vi.hoisted(() => ({
  createLinkCodeMock: vi.fn(),
  discordAccountMock: vi.fn(),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useCreateDiscordLinkCode: () => ({
    isPending: false,
    mutate: createLinkCodeMock,
  }),
  useDiscordLinkedAccount: discordAccountMock,
}));

import { DiscordLinkAccountStep } from './DiscordLinkAccountStep';

describe('DiscordLinkAccountStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discordAccountMock.mockReturnValue({
      data: { configured: true, mapping: null },
    });
    createLinkCodeMock.mockImplementation(
      (_input: undefined, options: { onSuccess: (result: unknown) => void }) =>
        options.onSuccess({
          code: 'link-example-code',
          command: '/link code:link-example-code',
          expiresInSeconds: 600,
          openDiscordUrl: 'https://discord.com/channels/@me',
        }),
    );
  });

  it('generates the slash command and offers to open Discord', async () => {
    render(<DiscordLinkAccountStep autoGenerate pollUntilLinked />);

    await waitFor(() => expect(createLinkCodeMock).toHaveBeenCalledOnce());
    expect(
      screen.getByText('/link code:link-example-code'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy Discord link command' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Discord/i })).toHaveAttribute(
      'href',
      'https://discord.com/channels/@me',
    );
  });
});
