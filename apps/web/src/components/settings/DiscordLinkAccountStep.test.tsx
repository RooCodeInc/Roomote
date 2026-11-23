import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { createLinkCodeMock, discordAccountMock, mutationState } = vi.hoisted(
  () => ({
    createLinkCodeMock: vi.fn(),
    discordAccountMock: vi.fn(),
    mutationState: { isPending: false, isError: false },
  }),
);

vi.mock('@/hooks/linked-accounts', () => ({
  useCreateDiscordLinkCode: () => ({
    ...mutationState,
    mutate: createLinkCodeMock,
  }),
  useDiscordLinkedAccount: discordAccountMock,
}));

import { DiscordLinkAccountStep } from './DiscordLinkAccountStep';

describe('DiscordLinkAccountStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationState.isPending = false;
    mutationState.isError = false;
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

  it('replaces the command in place after successful generation', () => {
    render(<DiscordLinkAccountStep autoGenerate />);
    createLinkCodeMock.mockImplementationOnce((_input, options) =>
      options.onSuccess({
        code: 'link-replacement-code',
        command: '/link code:link-replacement-code',
        expiresInSeconds: 600,
        openDiscordUrl: 'https://discord.com/channels/@me',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));
    expect(createLinkCodeMock).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText('/link code:link-example-code'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('/link code:link-replacement-code'),
    ).toBeInTheDocument();
  });

  it('preserves the prior command through pending and failed renewal with retry', () => {
    const { rerender } = render(<DiscordLinkAccountStep autoGenerate />);
    createLinkCodeMock.mockImplementationOnce(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));
    mutationState.isPending = true;
    rerender(<DiscordLinkAccountStep autoGenerate />);
    fireEvent.click(screen.getByRole('button', { name: 'Generating code…' }));
    expect(createLinkCodeMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('button', { name: 'Generating code…' }),
    ).toBeDisabled();
    expect(
      screen.getByText('/link code:link-example-code'),
    ).toBeInTheDocument();

    mutationState.isPending = false;
    mutationState.isError = true;
    rerender(<DiscordLinkAccountStep autoGenerate />);
    expect(screen.getByRole('alert')).toHaveTextContent('Please try again');
    expect(
      screen.getByText('/link code:link-example-code'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));
    expect(createLinkCodeMock).toHaveBeenCalledTimes(3);
  });

  it('hides code generation once the account is linked', () => {
    discordAccountMock.mockReturnValue({
      data: { configured: true, mapping: { discordUsername: 'grace_mock' } },
    });
    render(<DiscordLinkAccountStep autoGenerate />);
    expect(screen.getByText(/is linked/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(createLinkCodeMock).not.toHaveBeenCalled();
  });

  it('generates the slash command and offers to open Discord', async () => {
    render(<DiscordLinkAccountStep autoGenerate pollUntilLinked />);

    await waitFor(() => expect(createLinkCodeMock).toHaveBeenCalledOnce());
    expect(
      screen.getByText('/link code:link-example-code'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/run this command in a DM with the bot/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/enable Direct Messages/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy Discord link command' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Discord/i })).toHaveAttribute(
      'href',
      'https://discord.com/channels/@me',
    );
  });
});
