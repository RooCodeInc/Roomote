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
      message,
    });

    const card = blocks[0] as {
      output: { elements: Array<{ elements: Array<{ text: string }> }> };
    };
    const rendered = card.output.elements[0]!.elements[0]!.text;
    expect(rendered).toHaveLength(SLACK_LIVE_TASK_CARD_MESSAGE_MAX_CHARS);
    expect(rendered.endsWith('…')).toBe(true);
    expect(text).not.toContain(message);
  });
});
