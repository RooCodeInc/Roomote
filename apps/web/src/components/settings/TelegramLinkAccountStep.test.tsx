import { render, screen, waitFor } from '@testing-library/react';

const { createLinkCodeMock, telegramAccountMock } = vi.hoisted(() => ({
  createLinkCodeMock: vi.fn(),
  telegramAccountMock: vi.fn(),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useCreateTelegramLinkCode: () => ({
    isPending: false,
    mutate: createLinkCodeMock,
  }),
  useTelegramLinkedAccount: telegramAccountMock,
}));

import { TelegramLinkAccountStep } from './TelegramLinkAccountStep';

describe('TelegramLinkAccountStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
