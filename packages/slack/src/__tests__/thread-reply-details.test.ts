import {
  buildRoomoteSlackReplyBlocks,
  buildRoomoteSlackReplyFallbackText,
  isRoomoteSlackReplyContentBlock,
} from '../thread-reply-details';

describe('thread reply details blocks', () => {
  it('builds a divider plus one markdown block per finding when expanded', () => {
    expect(
      buildRoomoteSlackReplyBlocks({
        taskId: 'task-1',
        detailId: 'detail-1',
        summary: 'Summary',
        findings: [
          'First **detail**',
          'Second detail with a [link](https://example.com).',
        ],
        expanded: true,
      }),
    ).toEqual([
      {
        type: 'markdown',
        text: 'Summary',
      },
      {
        type: 'divider',
        block_id: 'roomote_slack_reply_details',
      },
      {
        type: 'markdown',
        text: '• First **detail**',
      },
      {
        type: 'markdown',
        text: '• Second detail with a [link](https://example.com).',
      },
      {
        type: 'actions',
        block_id: 'roomote_slack_reply_actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Less ⏶',
              emoji: false,
            },
            action_id: 'toggle_roomote_reply_details',
            value: '{"taskId":"task-1","detailId":"detail-1","expanded":true}',
          },
        ],
      },
    ]);
  });

  it('keeps fallback text as a single summary plus bullet list string', () => {
    expect(
      buildRoomoteSlackReplyFallbackText({
        summary: 'Summary',
        findings: ['First detail', 'Second detail'],
        expanded: true,
      }),
    ).toBe('Summary\n\n---\n\n• First detail\n• Second detail');
  });

  it('compresses overflow findings into the last detail section when the block budget is tight', () => {
    expect(
      buildRoomoteSlackReplyBlocks({
        taskId: 'task-1',
        detailId: 'detail-1',
        summary: 'Summary',
        findings: ['First detail', 'Second detail', 'Third detail'],
        expanded: true,
        maxBlocks: 4,
      }),
    ).toEqual([
      {
        type: 'markdown',
        text: 'Summary',
      },
      {
        type: 'divider',
        block_id: 'roomote_slack_reply_details',
      },
      {
        type: 'markdown',
        text: '• First detail\n• Second detail\n• Third detail',
      },
      {
        type: 'actions',
        block_id: 'roomote_slack_reply_actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Less ⏶',
              emoji: false,
            },
            action_id: 'toggle_roomote_reply_details',
            value: '{"taskId":"task-1","detailId":"detail-1","expanded":true}',
          },
        ],
      },
    ]);
  });

  it('keeps the summary/action pair within the remaining block budget', () => {
    expect(
      buildRoomoteSlackReplyBlocks({
        taskId: 'task-1',
        detailId: 'detail-1',
        summary: 'Summary',
        findings: ['First detail'],
        expanded: false,
        maxBlocks: 1,
      }),
    ).toEqual([
      {
        type: 'markdown',
        text: 'Summary',
      },
    ]);

    expect(
      buildRoomoteSlackReplyBlocks({
        taskId: 'task-1',
        detailId: 'detail-1',
        summary: 'Summary',
        findings: ['First detail'],
        expanded: true,
        maxBlocks: 1,
      }),
    ).toEqual([
      {
        type: 'markdown',
        text: 'Summary',
      },
    ]);
  });

  it('keeps long multi-paragraph summaries in full as markdown blocks', () => {
    const summary = [
      'First paragraph with **Markdown** and a [link](https://example.com).',
      '',
      'Second paragraph keeps its spacing.',
      '',
      '- Bullet one',
      '- Bullet two',
    ].join('\n\n');

    const blocks = buildRoomoteSlackReplyBlocks({
      taskId: 'task-1',
      detailId: 'detail-1',
      summary,
      findings: ['First detail'],
      expanded: false,
    });

    expect(blocks[0]).toEqual({
      type: 'markdown',
      text: summary,
    });
  });

  it('omits the divider when expanded details have no summary to separate from', () => {
    expect(
      buildRoomoteSlackReplyBlocks({
        taskId: 'task-1',
        detailId: 'detail-1',
        findings: ['First detail'],
        expanded: true,
      }),
    ).toEqual([
      {
        type: 'markdown',
        text: '• First detail',
      },
      {
        type: 'actions',
        block_id: 'roomote_slack_reply_actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Less ⏶',
              emoji: false,
            },
            action_id: 'toggle_roomote_reply_details',
            value: '{"taskId":"task-1","detailId":"detail-1","expanded":true}',
          },
        ],
      },
    ]);

    expect(
      buildRoomoteSlackReplyFallbackText({
        findings: ['First detail'],
        expanded: true,
      }),
    ).toBe('• First detail');
  });

  it('treats legacy detail content blocks as reply content', () => {
    expect(
      isRoomoteSlackReplyContentBlock({
        type: 'header',
        block_id: 'roomote_slack_reply_details_header',
      }),
    ).toBe(true);
    expect(
      isRoomoteSlackReplyContentBlock({
        type: 'section',
        block_id: 'roomote_slack_reply_detail_0',
      }),
    ).toBe(true);
    expect(
      isRoomoteSlackReplyContentBlock({
        type: 'section',
        block_id: 'roomote_slack_reply_details',
      }),
    ).toBe(true);
    expect(
      isRoomoteSlackReplyContentBlock({
        type: 'section',
        block_id: 'roomote_thread_reply_quote',
      }),
    ).toBe(false);
  });
});
