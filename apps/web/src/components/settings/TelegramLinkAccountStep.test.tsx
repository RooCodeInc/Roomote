import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { createLinkCodeMock, telegramAccountMock, mutationState } = vi.hoisted(
  () => ({
    createLinkCodeMock: vi.fn(),
    telegramAccountMock: vi.fn(),
    mutationState: { isPending: false, isError: false },
  }),
);

vi.mock('@/hooks/linked-accounts', () => ({
  useCreateTelegramLinkCode: () => ({
    ...mutationState,
    mutate: createLinkCodeMock,
  }),
  useTelegramLinkedAccount: telegramAccountMock,
}));

import { TelegramLinkAccountStep } from './TelegramLinkAccountStep';

describe('TelegramLinkAccountStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationState.isPending = false;
    mutationState.isError = false;
    telegramAccountMock.mockReturnValue({
      data: { configured: true, mapping: null },
    });
    createLinkCodeMock.mockImplementation(
      (_input: undefined, options: { onSuccess: (result: unknown) => void }) =>
        options.onSuccess({
          code: 'link-example-code',
          expiresInSeconds: 600,
          deepLink: 'https://t.me/roomote_bot?start=link-example-code',
        }),
    );
  });

  it('replaces the code and deep link in place only after successful generation', () => {
    render(<TelegramLinkAccountStep autoGenerate />);
    createLinkCodeMock.mockImplementationOnce((_input, options) =>
      options.onSuccess({
        code: 'link-replacement-code',
        expiresInSeconds: 600,
        deepLink: 'https://t.me/roomote_bot?start=link-replacement-code',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));

    expect(createLinkCodeMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('link-example-code')).not.toBeInTheDocument();
    expect(screen.getByText('link-replacement-code')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the bot/i })).toHaveAttribute(
      'href',
      'https://t.me/roomote_bot?start=link-replacement-code',
    );
  });

  it('keeps the prior code through a pending or failed renewal and allows retry', () => {
    const { rerender } = render(<TelegramLinkAccountStep autoGenerate />);
    createLinkCodeMock.mockImplementationOnce(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));
    mutationState.isPending = true;
    rerender(<TelegramLinkAccountStep autoGenerate />);
    fireEvent.click(screen.getByRole('button', { name: 'Generating code…' }));
    expect(createLinkCodeMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole('button', { name: 'Generating code…' }),
    ).toBeDisabled();
    expect(screen.getByText('link-example-code')).toBeInTheDocument();

    mutationState.isPending = false;
    mutationState.isError = true;
    rerender(<TelegramLinkAccountStep autoGenerate />);
    expect(screen.getByRole('alert')).toHaveTextContent('Please try again');
    expect(screen.getByText('link-example-code')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));
    expect(createLinkCodeMock).toHaveBeenCalledTimes(3);
  });

  it('hides code generation once the account is linked', () => {
    telegramAccountMock.mockReturnValue({
      data: { configured: true, mapping: { telegramUsername: 'grace_mock' } },
    });
    render(<TelegramLinkAccountStep autoGenerate />);
    expect(screen.getByText(/is linked/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(createLinkCodeMock).not.toHaveBeenCalled();
  });

  it('automatically generates the onboarding link and uses the shared copy control', async () => {
    render(<TelegramLinkAccountStep autoGenerate pollUntilLinked />);

    await waitFor(() => expect(createLinkCodeMock).toHaveBeenCalledOnce());
    expect(screen.getByText('link-example-code')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy Telegram link code' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Open the bot in Telegram/i }),
    ).toHaveAttribute(
      'href',
      'https://t.me/roomote_bot?start=link-example-code',
    );
  });
});
