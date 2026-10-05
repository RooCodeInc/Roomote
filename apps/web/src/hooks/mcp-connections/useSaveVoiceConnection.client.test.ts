import { act, renderHook } from '@testing-library/react';

const { mocks, mutationOptions } = vi.hoisted(() => ({
  mutationOptions: [] as unknown[],
  mocks: {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: unknown) => {
    mutationOptions.push(options);
    return { isPending: false, mutate: vi.fn() };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => {
    const query = (key: string) => ({ queryKey: () => [key] });

    return {
      mcpConnections: {
        saveVoiceConnection: { mutationOptions: (options: unknown) => options },
        effectiveIntegrations: query('effective'),
        deploymentEnablements: query('enablements'),
        userConnections: query('connections'),
        oauthReadiness: query('oauth'),
        availability: query('availability'),
        voiceConnection: query('voice'),
      },
    };
  },
}));

import { useSaveVoiceConnection } from './useSaveVoiceConnection';

type SaveVoiceMutationOptions = {
  onSuccess?: () => void;
};

describe('useSaveVoiceConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutationOptions.length = 0;
  });

  it('refreshes every integration status projection after saving', async () => {
    renderHook(() => useSaveVoiceConnection());

    const options = mutationOptions[0] as SaveVoiceMutationOptions;

    await act(async () => {
      options.onSuccess?.();
      await Promise.resolve();
    });

    expect(
      mocks.invalidateQueries.mock.calls.map(([input]) => input.queryKey),
    ).toEqual([
      ['effective'],
      ['enablements'],
      ['connections'],
      ['oauth'],
      ['availability'],
      ['voice'],
    ]);
  });
});
