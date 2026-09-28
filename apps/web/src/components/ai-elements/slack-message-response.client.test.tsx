import { cleanup, render, screen } from '@testing-library/react';

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

import { MessageResponse } from './message';
import { renderSlackMessageMarkdown } from './slack-message-references';

beforeEach(cleanup);
afterEach(cleanup);

describe('Slack references in assistant Markdown', () => {
  it('renders resolved users and channels as links without dropping Markdown', async () => {
    const text = 'Post in <#C456> and ask <@U123>. **Keep this bold.**';
    render(
      <MessageResponse>
        {renderSlackMessageMarkdown(text, {
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
        })}
      </MessageResponse>,
    );

    const channelLink = await screen.findByRole('link', { name: '#ops' });
    expect(channelLink).toHaveAttribute(
      'href',
      'https://acme.slack.com/archives/C456',
    );
    const userLink = await screen.findByRole('link', { name: '@Maya' });
    expect(userLink).toHaveAttribute(
      'href',
      'https://acme.slack.com/team/U123',
    );
    expect(screen.getByText('Keep this bold.')).toBeInTheDocument();
  });

  it('leaves Slack references inside code untouched', () => {
    const text = '`<#C456>`\n\n```text\n<@U123>\n```\n\n<#C456>';
    const markdown = renderSlackMessageMarkdown(text, {
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
    });

    expect(markdown).toContain('`<#C456>`');
    expect(markdown).toContain('```text\n<@U123>\n```');
    expect(markdown).toContain('[#ops](https://acme.slack.com/archives/C456)');
  });
});
