import {
  buildSlackLiveTaskCardBlocks,
  SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS,
} from '../live-task-card-blocks';

describe('buildSlackLiveTaskCardBlocks', () => {
  it('caps the output so Slack never rejects a settling render', () => {
    const message = 'x'.repeat(SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS + 500);
    const { text, blocks } = buildSlackLiveTaskCardBlocks({
      taskUpdateId: 'roomote-task-task-1',
      title: 'Fix the button',
      status: 'complete',
      output: message,
    });

    const card = blocks[0] as {
      output: { elements: Array<{ elements: Array<{ text: string }> }> };
    };
    const rendered = card.output.elements[0]!.elements[0]!.text;
    expect(rendered).toHaveLength(SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS);
    expect(rendered.endsWith('…')).toBe(true);
    expect(text).not.toContain(message);
  });

  it.each(['pending', 'in_progress'] as const)(
    'renders %s work as task details instead of output',
    (status) => {
      const { text, blocks } = buildSlackLiveTaskCardBlocks({
        taskUpdateId: 'roomote-task-task-1',
        title: 'Fix the button',
        status,
        details: 'Running the tests.',
        taskUrl: 'https://roomote.example/task/task-1',
      });

      expect(blocks[0]).toEqual({
        type: 'task_card',
        block_id: 'roomote-task-task-1-card',
        task_id: 'roomote-task-task-1',
        title: 'Fix the button',
        status,
        details: {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: 'Running the tests.' }],
            },
          ],
        },
        sources: [
          {
            type: 'url',
            url: 'https://roomote.example/task/task-1',
            text: 'Open in Roomote',
          },
        ],
      });
      expect(blocks[0]).not.toHaveProperty('output');
      expect(text).toBe(
        'Fix the button\nRunning the tests.\n<https://roomote.example/task/task-1|Open in Roomote>',
      );
    },
  );

  it('keeps a completed result in output alongside the latest details', () => {
    const { text, blocks } = buildSlackLiveTaskCardBlocks({
      taskUpdateId: 'roomote-task-task-1',
      title: 'Fix the button',
      status: 'complete',
      details: 'Running the tests.',
      output: 'Ready for review.',
    });

    expect(blocks[0]).toEqual({
      type: 'task_card',
      block_id: 'roomote-task-task-1-card',
      task_id: 'roomote-task-task-1',
      title: 'Fix the button',
      status: 'complete',
      details: {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'Running the tests.' }],
          },
        ],
      },
      output: {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'Ready for review.' }],
          },
        ],
      },
    });
    expect(text).toBe('Fix the button\nReady for review.');
  });

  it('renders an error result as output without task details', () => {
    const { blocks } = buildSlackLiveTaskCardBlocks({
      taskUpdateId: 'roomote-task-task-1',
      title: 'Fix the button',
      status: 'error',
      output: 'Stopped because of an error.',
    });

    expect(blocks[0]).toMatchObject({
      status: 'error',
      output: {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'Stopped because of an error.' }],
          },
        ],
      },
    });
    expect(blocks[0]).not.toHaveProperty('details');
  });
});
