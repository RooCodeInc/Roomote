import { formatLinearIssueContext } from '../linearAgentSession';

describe('formatLinearIssueContext', () => {
  it('excludes Linear agent-system comments from the prompt context', () => {
    const context = formatLinearIssueContext({
      previousComments: [
        {
          id: 'agent-session-comment',
          body: 'This thread is for an agent session with bruno.',
          userId: 'bot:agent-session-comment',
          username: 'Linear',
        },
        {
          id: 'human-comment',
          body: 'Please make the background red.',
          userId: 'linear-user-1',
          username: 'Bruno',
        },
      ],
    });

    expect(context).toContain('Please make the background red.');
    expect(context).not.toContain('This thread is for an agent session');
  });
});
