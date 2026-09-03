import { render, screen } from '@testing-library/react';

import { SlackMentionProvider } from './slack-mention-context';
import { SlackMessageText } from './slack-message-text';

const resolveUsersState = vi.hoisted(() => ({
  data: undefined as
    | { users: Record<string, { name: string; profileUrl: string | null }> }
    | undefined,
  lastInput: null as { scope: unknown; userIds: string[] } | null,
  lastEnabled: null as boolean | null,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { enabled?: boolean }) => {
    resolveUsersState.lastEnabled = options.enabled ?? true;
    return { data: resolveUsersState.data };
  },
}));

vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    slack: {
      resolveUsers: {
        queryOptions: (input: { scope: unknown; userIds: string[] }) => {
          resolveUsersState.lastInput = input;
          return { queryKey: ['slack.resolveUsers', input] };
        },
      },
    },
  }),
}));

describe('SlackMessageText', () => {
  beforeEach(() => {
    resolveUsersState.data = undefined;
    resolveUsersState.lastInput = null;
    resolveUsersState.lastEnabled = null;
  });

  it('renders plain text untouched without querying Slack', () => {
    render(<SlackMessageText text="just a message" />);

    expect(screen.getByText('just a message')).toBeInTheDocument();
    expect(resolveUsersState.lastEnabled).toBe(false);
    expect(screen.queryByTestId('slack-mention')).not.toBeInTheDocument();
  });

  it('links resolved user mentions to their Slack profile', () => {
    resolveUsersState.data = {
      users: {
        U0BJNE7FC12: {
          name: 'Roomote',
          profileUrl: 'https://acme.slack.com/team/U0BJNE7FC12',
        },
      },
    };

    render(
      <SlackMentionProvider scope={{ kind: 'session', sessionId: 'session-1' }}>
        <SlackMessageText text="<@U0BJNE7FC12> determine why the link fails" />
      </SlackMentionProvider>,
    );

    const mention = screen.getByTestId('slack-mention');
    expect(mention).toHaveTextContent('@Roomote');
    expect(mention).toHaveAttribute(
      'href',
      'https://acme.slack.com/team/U0BJNE7FC12',
    );
    expect(mention).toHaveAttribute('target', '_blank');
    expect(
      screen.getByText(/determine why the link fails/),
    ).toBeInTheDocument();
    expect(resolveUsersState.lastInput).toEqual({
      scope: { kind: 'session', sessionId: 'session-1' },
      userIds: ['U0BJNE7FC12'],
    });
    expect(resolveUsersState.lastEnabled).toBe(true);
  });

  it('renders Slack link tokens and bare urls as links', () => {
    render(
      <SlackMessageText text="I like <https://roomote.dev> and <https://example.com|Example>, also https://docs.roomote.dev/start." />,
    );

    const links = screen.getAllByTestId('slack-link');
    expect(
      links.map((node) => [node.textContent, node.getAttribute('href')]),
    ).toEqual([
      ['https://roomote.dev', 'https://roomote.dev'],
      ['Example', 'https://example.com'],
      ['https://docs.roomote.dev/start', 'https://docs.roomote.dev/start'],
    ]);
    expect(screen.getByText(/, also/)).toBeInTheDocument();
    expect(resolveUsersState.lastEnabled).toBe(false);
  });

  it('does not query without a transcript scope', () => {
    render(<SlackMessageText text="<@U1> hi" />);

    expect(resolveUsersState.lastEnabled).toBe(false);
    expect(screen.getByTestId('slack-mention')).toHaveTextContent('@U1');
  });

  it('caps the lookup at the resolver limit and leaves overflow raw', () => {
    const text = Array.from({ length: 60 }, (_, i) => `<@U${i}>`).join(' ');

    render(
      <SlackMentionProvider scope={{ kind: 'task', taskId: 'task-1' }}>
        <SlackMessageText text={text} />
      </SlackMentionProvider>,
    );

    expect(resolveUsersState.lastInput?.userIds).toHaveLength(50);
    expect(screen.getAllByTestId('slack-mention')).toHaveLength(60);
  });

  it('falls back to the inline label or raw id while unresolved', () => {
    render(
      <SlackMessageText text="<@U1|jane> and <@U2> in <#C1|general> <!here>" />,
    );

    const mentions = screen.getAllByTestId('slack-mention');
    expect(mentions.map((node) => node.textContent)).toEqual([
      '@jane',
      '@U2',
      '#general',
      '@here',
    ]);
    for (const mention of mentions) {
      expect(mention.tagName).toBe('SPAN');
    }
  });
});
