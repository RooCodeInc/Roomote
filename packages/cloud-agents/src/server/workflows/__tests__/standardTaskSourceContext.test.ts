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
    expect(harnessInstructions).toContain(
      'When an instruction says to report back to the source thread, it means this originating conversation.',
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
});
