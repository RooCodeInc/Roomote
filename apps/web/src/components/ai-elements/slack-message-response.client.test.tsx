import { cleanup, render, screen } from '@testing-library/react';

import { SlackMentionProvider } from './slack-mention-context';
import { SlackMentionResolutionProvider } from './slack-message-references';
import { SlackMessageResponse } from './slack-message-response';

const resolveState = vi.hoisted(() => ({
  data: undefined as
    | {
        users: Record<string, { name: string; profileUrl: string | null }>;
        channels: Record<string, { name: string; url: string | null }>;
      }
    | undefined,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: resolveState.data }),
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    slack: {
      resolveUsers: {
        queryOptions: (input: unknown) => ({
          queryKey: ['slack.resolveUsers', input],
        }),
      },
    },
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/task/task-1',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/app/(sandbox)/task/[taskId]/hooks/ArtifactLinkProvider', () => ({
  useArtifactLink: () => null,
}));

vi.mock(
  '@/app/(sandbox)/sessions/[sessionId]/session-task-panel-context',
  () => ({
    useOpenSessionArtifactViewer: () => null,
  }),
);

const resolvedData = {
  users: {
    U123: {
      name: 'Maya',
      profileUrl: 'https://acme.slack.com/team/U123',
    },
  },
  channels: {
    C456: {
      name: 'ops',
      url: 'https://acme.slack.com/archives/C456',
    },
  },
};

beforeEach(() => {
  cleanup();
  resolveState.data = resolvedData;
});

afterEach(cleanup);

function renderResponse(text: string) {
  return (
    <SlackMentionProvider scope={{ kind: 'session', sessionId: 'session-1' }}>
      <SlackMentionResolutionProvider text={text}>
        <SlackMessageResponse text={text} />
      </SlackMentionResolutionProvider>
    </SlackMentionProvider>
  );
}

describe('Slack references in assistant Markdown', () => {
  it('renders resolved users and channels without dropping Markdown', async () => {
    render(
      renderResponse('Post in <#C456> and ask <@U123>. **Keep this bold.**'),
    );
    expect(await screen.findByRole('link', { name: '#ops' })).toHaveAttribute(
      'href',
      'https://acme.slack.com/archives/C456',
    );
    expect(await screen.findByRole('link', { name: '@Maya' })).toHaveAttribute(
      'href',
      'https://acme.slack.com/team/U123',
    );
    expect(screen.getByText('Keep this bold.')).toBeInTheDocument();
  });

  it('updates links when resolver data arrives after hydration', async () => {
    const text = 'Post in <#C456> and ask <@U123>.';
    resolveState.data = undefined;
    const { rerender } = render(renderResponse(text));

    expect(await screen.findByText(/Post in/)).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: '#ops' }),
    ).not.toBeInTheDocument();

    resolveState.data = resolvedData;
    rerender(renderResponse(text));

    expect(await screen.findByRole('link', { name: '#ops' })).toHaveAttribute(
      'href',
      'https://acme.slack.com/archives/C456',
    );
    expect(await screen.findByRole('link', { name: '@Maya' })).toHaveAttribute(
      'href',
      'https://acme.slack.com/team/U123',
    );
  });

  it('preserves existing Markdown links and code contexts', async () => {
    render(
      renderResponse(
        '[<@U123>](https://example.com)\n\n`<#C456>`\n\n> ```text\n> <@U123>\n>```\n\n<#C456>',
      ),
    );

    expect(
      await screen.findByRole('link', { name: '<@U123>' }),
    ).toHaveAttribute('href', 'https://example.com/');
    expect(screen.getByText('<#C456>')).toBeInTheDocument();
    expect(screen.getAllByText('<@U123>')).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: '#ops' })).toHaveLength(1);
  });
});
