import { render, screen, waitFor } from '@testing-library/react';

const { startMutateMock } = vi.hoisted(() => ({
  startMutateMock: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <div data-testid="pairing-qr">{value}</div>
  ),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    kind: 'start' | 'check';
    onSuccess?: (result: { pairingId: string; deepLink: string }) => void;
  }) => {
    if (options.kind === 'start') {
      const mutate = () => {
        startMutateMock();
        options.onSuccess?.({
          pairingId: '11111111-1111-4111-8111-111111111111',
          deepLink: 'https://t.me/RoomoteSetupBot?start=opaque-claim-token',
        });
      };
      return {
        isError: false,
        isPending: false,
        mutate,
        reset: vi.fn(),
      };
    }

    return {
      mutateAsync: vi.fn(),
    };
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    comms: {
      startTelegramPairing: {
        mutationOptions: (options: object) => ({
          ...options,
          kind: 'start',
        }),
      },
      checkTelegramPairing: {
        mutationOptions: (options?: object) => ({
          ...options,
          kind: 'check',
        }),
      },
    },
  }),
}));

import { TelegramManagedBotPairing } from './TelegramManagedBotPairing';

describe('TelegramManagedBotPairing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts pairing on mount and shows the resulting QR code and link', async () => {
    render(<TelegramManagedBotPairing onPaired={vi.fn()} />);

    await waitFor(() => {
      expect(startMutateMock).toHaveBeenCalledTimes(1);
    });

    const link = await screen.findByRole('link', {
      name: /Open in Telegram/,
    });
    expect(link).toHaveAttribute(
      'href',
      'https://t.me/RoomoteSetupBot?start=opaque-claim-token',
    );
    expect(screen.getByTestId('pairing-qr')).toHaveTextContent(
      'https://t.me/RoomoteSetupBot?start=opaque-claim-token',
    );
    expect(
      screen.queryByRole('button', {
        name: 'Create my Telegram bot',
      }),
    ).not.toBeInTheDocument();
  });
});
