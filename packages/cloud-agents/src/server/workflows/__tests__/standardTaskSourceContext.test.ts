import { standardTask } from '../standardTask';

describe('standardTask source context', () => {
  it('exposes communication coordinates and optional completion reporting', () => {
    const { harnessInstructions } = standardTask({
      description: 'Do the work',
      repo: 'RooCodeInc/Roomote',
      taskSurface: 'slack',
      sourceProvider: 'slack',
      sourceChannelId: 'C123',
      sourceThreadId: '123.456',
      sourceMessageId: '123.789',
    });

    expect(harnessInstructions).toContain('<task_source_context>');
    expect(harnessInstructions).toContain('<source>slack</source>');
    expect(harnessInstructions).toContain('<channel_id>C123</channel_id>');
    expect(harnessInstructions).toContain('<thread_id>123.456</thread_id>');
    expect(harnessInstructions).toContain('<message_id>123.789</message_id>');
    expect(harnessInstructions).not.toContain(
      'report back to the source thread',
    );
  });

  it('does not add source context to web tasks without communication metadata', () => {
    const { harnessInstructions } = standardTask({
      description: 'Do the work',
      repo: 'RooCodeInc/Roomote',
      taskSurface: 'web',
    });

    expect(harnessInstructions).not.toContain('<task_source_context>');
  });

  it('keeps informational Slack source context separate from the web surface', () => {
    const slackPermalink =
      'https://acme.slack.com/archives/C123/p1234567890000200?thread_ts=1234567890.000100&cid=C123';
    const { harnessInstructions } = standardTask({
      description: 'Do the work',
      repo: 'RooCodeInc/Roomote',
      taskSurface: 'web',
      taskRunUrl: 'https://roomote.example/task/task-1',
      sourceProvider: 'slack',
      sourceChannelId: 'C123',
      sourceThreadId: '1234567890.000100',
      sourceMessageId: '1234567890.000200',
      slackTeamDomain: 'acme',
      slackTeamId: 'T123',
      slackChannel: 'C123',
      slackThreadTs: '1234567890.000100',
      slackConversationUrl: slackPermalink,
    });

    expect(harnessInstructions).toContain(
      'This StandardTask run was launched from the Roomote web task UI.',
    );
    expect(harnessInstructions).toContain('<source>slack</source>');
    expect(harnessInstructions).not.toContain(
      'This run was launched from a Slack conversation surface',
    );
    expect(harnessInstructions).toContain(`[Slack](${slackPermalink})`);
  });

  it('uses inherited Discord coordinates for PR attribution without changing the web surface', () => {
    const { harnessInstructions } = standardTask({
      description: 'Do the work',
      repo: 'RooCodeInc/Roomote',
      taskSurface: 'web',
      taskRunUrl: 'https://roomote.example/task/task-1',
      sourceProvider: 'discord',
      sourceChannelId: 'C123',
      sourceMessageId: 'M123',
      discordGuildId: 'G123',
      discordChannelId: 'C123',
      discordMessageId: 'M123',
    });

    expect(harnessInstructions).toContain(
      'This StandardTask run was launched from the Roomote web task UI.',
    );
    expect(harnessInstructions).not.toContain(
      'This run was launched from a Discord conversation surface',
    );
    expect(harnessInstructions).toContain(
      '[Discord](https://discord.com/channels/G123/C123/M123)',
    );
  });
});
