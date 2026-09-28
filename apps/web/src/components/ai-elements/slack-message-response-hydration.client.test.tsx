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

afterEach(cleanup);

it('updates assistant Slack links when resolver data arrives after hydration', async () => {
  const text = 'Post in <#C456> and ask <@U123>.';
  const { rerender } = render(
    <MessageResponse>
      {renderSlackMessageMarkdown(text, { users: {}, channels: {} })}
    </MessageResponse>,
  );

  expect(await screen.findByText(/Post in/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '#ops' })).not.toBeInTheDocument();

  rerender(
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

  expect(await screen.findByRole('link', { name: '#ops' })).toHaveAttribute(
    'href',
    'https://acme.slack.com/archives/C456',
  );
  expect(await screen.findByRole('link', { name: '@Maya' })).toHaveAttribute(
    'href',
    'https://acme.slack.com/team/U123',
  );
});
