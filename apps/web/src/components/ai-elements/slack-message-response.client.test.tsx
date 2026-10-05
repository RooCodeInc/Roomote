import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { useState } from 'react';
import { MessageResponse } from './message';
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

  it('renders resolved references in headings and tight list items', async () => {
    render(renderResponse('## <#C456>\n\n- ask <@U123> to post there'));

    const heading = await screen.findByRole('heading', { name: '#ops' });
    expect(heading).toHaveAttribute('data-streamdown', 'heading-2');
    expect(await screen.findByRole('link', { name: '#ops' })).toHaveAttribute(
      'href',
      'https://acme.slack.com/archives/C456',
    );
    expect(await screen.findByRole('link', { name: '@Maya' })).toHaveAttribute(
      'href',
      'https://acme.slack.com/team/U123',
    );
    expect(screen.getByRole('listitem')).toHaveAttribute(
      'data-streamdown',
      'list-item',
    );
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
    await waitFor(() => {
      expect(
        document.querySelector('[data-streamdown="code-block-body"]'),
      ).toHaveTextContent('<@U123>');
    });
    expect(
      screen.queryByRole('link', { name: '@Maya' }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '#ops' })).toHaveLength(1);
  });
});

describe('Markdown and transcript state regressions', () => {
  it('preserves draft state when first reference arrives', () => {
    function Draft() {
      const [value, setValue] = useState('');
      return (
        <input
          aria-label="draft"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }
    function Tree({ text }: { text: string }) {
      return (
        <SlackMentionResolutionProvider text={text}>
          <Draft />
        </SlackMentionResolutionProvider>
      );
    }
    const { rerender } = render(<Tree text="hello" />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'unsent reply' },
    });
    rerender(<Tree text="hello <@U123>" />);
    expect(screen.getByRole('textbox')).toHaveValue('unsent reply');
    rerender(<Tree text="hello again" />);
    expect(screen.getByRole('textbox')).toHaveValue('unsent reply');
  });

  it('retains Streamdown code block UI', async () => {
    const text = '```js\nconst answer = 42;\n```';
    const baseline = render(<MessageResponse>{text}</MessageResponse>);
    expect(
      await screen.findByRole('button', { name: /copy/i }),
    ).toBeInTheDocument();
    baseline.unmount();
    render(renderResponse(text));
    expect(
      await screen.findByRole('button', { name: /copy/i }),
    ).toBeInTheDocument();
  });

  it.each([
    '**<@U123>**',
    '*<@U123>*',
    '~~<@U123>~~',
    '| Person |\n| --- |\n| <@U123> |',
    '| <@U123> |\n| --- |\n| Person |',
  ])('resolves mention in %s', async (text) => {
    render(renderResponse(text));
    expect(
      await screen.findByRole('link', { name: '@Maya' }),
    ).toBeInTheDocument();
  });
});
