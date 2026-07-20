import { fireEvent, render, screen } from '@testing-library/react';

const mutations = vi.hoisted(() => ({
  slack: vi.fn(),
  github: vi.fn(),
  gitlab: vi.fn(),
  gitea: vi.fn(),
  bitbucket: vi.fn(),
  ado: vi.fn(),
  microsoft: vi.fn(),
  telegram: vi.fn(),
  discord: vi.fn(),
}));

const unlinked = { data: { mapping: null, configured: true } };

vi.mock('@/hooks/github', () => ({
  useAuthenticateGitHubAccount: () => ({
    mutate: mutations.github,
    isPending: false,
  }),
}));

vi.mock('@/hooks/slack', () => ({
  useAuthenticateSlackAccount: () => ({
    mutate: mutations.slack,
    isPending: false,
  }),
}));

vi.mock('@/hooks/linked-accounts', () => ({
  useAuthenticateGitLabAccount: () => ({
    mutate: mutations.gitlab,
    isPending: false,
  }),
  useAuthenticateGiteaAccount: () => ({
    mutate: mutations.gitea,
    isPending: false,
  }),
  useAuthenticateBitbucketAccount: () => ({
    mutate: mutations.bitbucket,
    isPending: false,
  }),
  useAuthenticateAdoAccount: () => ({
    mutate: mutations.ado,
    isPending: false,
  }),
  useAuthenticateMicrosoftTeamsAccount: () => ({
    mutate: mutations.microsoft,
    isPending: false,
  }),
  useCreateTelegramLinkCode: () => ({
    mutate: mutations.telegram,
    isPending: false,
  }),
  useCreateDiscordLinkCode: () => ({
    mutate: mutations.discord,
    isPending: false,
  }),
  useTelegramLinkedAccount: () => unlinked,
  useDiscordLinkedAccount: () => unlinked,
}));

vi.mock('@/components/system', () => ({
  BrandIcon: () => <span />,
  Button: ({ children, onClick, disabled }: React.ComponentProps<'button'>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Spinner: () => <span />,
}));

vi.mock('../setup/StepTitle', () => ({
  StepTitle: ({ text }: { text: string }) => <h1>{text}</h1>,
}));

import { ProviderLinkStep } from './ProviderLinkStep';

const defaults = {
  githubAppSlug: 'roomote',
  onContinue: vi.fn(),
  onLinked: vi.fn(),
};

describe('ProviderLinkStep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts configured OAuth links with a callback to the current provider step', () => {
    render(
      <ProviderLinkStep
        {...defaults}
        provider={{
          id: 'gitlab',
          category: 'source-control',
          label: 'GitLab',
          configured: true,
          linked: false,
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /link gitlab account/i }),
    );

    expect(mutations.gitlab).toHaveBeenCalledWith(
      '/onboarding?step=gitlab',
      expect.any(Object),
    );
  });

  it('allows users to defer a provider link', () => {
    const onContinue = vi.fn();
    render(
      <ProviderLinkStep
        {...defaults}
        onContinue={onContinue}
        provider={{
          id: 'slack',
          category: 'communication',
          label: 'Slack',
          configured: true,
          linked: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /do this later/i }));

    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('generates a Telegram code instead of starting an OAuth redirect', () => {
    mutations.telegram.mockImplementation(
      (_value: undefined, options: { onSuccess: (result: unknown) => void }) =>
        options.onSuccess({
          code: 'telegram-code',
          expiresInSeconds: 600,
          deepLink: 'https://t.me/roomote?start=telegram-code',
        }),
    );

    render(
      <ProviderLinkStep
        {...defaults}
        provider={{
          id: 'telegram',
          category: 'communication',
          label: 'Telegram',
          configured: true,
          linked: false,
        }}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /link telegram account/i }),
    );

    expect(mutations.telegram).toHaveBeenCalledWith(
      undefined,
      expect.any(Object),
    );
    expect(screen.getByText('telegram-code')).toBeInTheDocument();
  });
});
