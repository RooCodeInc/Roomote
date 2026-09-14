import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { acceptVoiceConsent, fetchQuery, setQueryData, useQueryState } =
  vi.hoisted(() => ({
    acceptVoiceConsent: vi.fn(),
    fetchQuery: vi.fn(),
    setQueryData: vi.fn(),
    useQueryState: { data: undefined as boolean | undefined },
  }));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({
    isPending: false,
    mutateAsync: acceptVoiceConsent,
  }),
  useQuery: () => useQueryState,
  useQueryClient: () => ({ fetchQuery, setQueryData }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    preferences: {
      acceptVoiceConsent: { mutationOptions: () => ({}) },
      getVoiceConsent: {
        queryOptions: () => ({ queryKey: ['preferences', 'voice-consent'] }),
      },
    },
  }),
}));

import { useVoiceConsent, VoiceConsentProvider } from './VoiceConsentProvider';

function VoiceStarter({ onStart }: { onStart: () => void }) {
  const requestConsent = useVoiceConsent();

  return (
    <button
      onClick={async () => {
        if (await requestConsent()) onStart();
      }}
      type="button"
    >
      Start voice
    </button>
  );
}

function renderProvider(cloudEnabled: boolean, onStart = vi.fn()) {
  render(
    <VoiceConsentProvider cloudEnabled={cloudEnabled}>
      <VoiceStarter onStart={onStart} />
    </VoiceConsentProvider>,
  );
  return onStart;
}

describe('VoiceConsentProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueryState.data = undefined;
    fetchQuery.mockResolvedValue(false);
    acceptVoiceConsent.mockResolvedValue(true);
  });

  it('starts immediately without reading consent outside cloud deployments', async () => {
    const onStart = renderProvider(false);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(fetchQuery).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts immediately when this user already accepted', async () => {
    useQueryState.data = true;
    const onStart = renderProvider(true);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(acceptVoiceConsent).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not start or record consent when the first-use dialog is dismissed', async () => {
    const onStart = renderProvider(true);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    expect(
      await screen.findByRole('dialog', { name: 'Try experimental voice' }),
    ).toBeVisible();
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(acceptVoiceConsent).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('persists explicit acceptance before starting the original action', async () => {
    let persistAcceptance!: () => void;
    acceptVoiceConsent.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        persistAcceptance = () => resolve(true);
      }),
    );
    const onStart = renderProvider(true);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with voice' }),
    );

    expect(acceptVoiceConsent).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();

    persistAcceptance();

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(setQueryData).toHaveBeenCalledWith(
      ['preferences', 'voice-consent'],
      true,
    );
  });
});
