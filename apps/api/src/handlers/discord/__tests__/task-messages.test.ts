import { discordTaskAcknowledgementText } from '../task-messages.js';

describe('discordTaskAcknowledgementText', () => {
  it('uses the static template when no kickoff is provided', () => {
    expect(
      discordTaskAcknowledgementText({
        workspaceDisplayName: 'Roomote',
        taskUrl: 'https://roomote.example/task/1',
      }),
    ).toBe('Started a task in Roomote.');

    expect(
      discordTaskAcknowledgementText({
        workspaceDisplayName: 'Roomote',
        taskUrl: null,
      }),
    ).toBe('Queued a task in Roomote.');
  });

  it('posts the router free-form kickoff as-is when present', () => {
    expect(
      discordTaskAcknowledgementText({
        workspaceDisplayName: 'Roomote',
        taskUrl: 'https://roomote.example/task/1',
        kickoffMessage: 'Taking a screenshot of the homepage in Roomote.',
      }),
    ).toBe('Taking a screenshot of the homepage in Roomote.');
  });

  it('falls back when the kickoff is blank or only whitespace', () => {
    expect(
      discordTaskAcknowledgementText({
        workspaceDisplayName: 'Roomote',
        taskUrl: 'https://roomote.example/task/1',
        kickoffMessage: '   ',
      }),
    ).toBe('Started a task in Roomote.');
  });
});
