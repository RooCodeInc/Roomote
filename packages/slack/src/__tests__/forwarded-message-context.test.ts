import {
  appendSlackAttachmentContext,
  appendSlackForwardedMessageFiles,
  appendSlackForwardedMessageContext,
  extractSlackForwardedMessageFiles,
  formatSlackAttachmentTitleContexts,
  formatSlackAttachmentContext,
  formatSlackBlockLinkContext,
  formatSlackBlockTextContext,
  formatSlackForwardedMessageContext,
} from '../forwarded-message-context';
import type { SlackFile } from '../types';

describe('forwarded-message-context', () => {
  it('includes native chart data in agent-visible Slack context', () => {
    expect(
      formatSlackBlockTextContext([
        {
          type: 'data_visualization',
          title: 'Weekly sales',
          chart: {
            type: 'line',
            series: [
              {
                name: 'Online',
                data: [
                  { label: 'Week 1', value: 12 },
                  { label: 'Week 2', value: 18 },
                ],
              },
            ],
            axis_config: { categories: ['Week 1', 'Week 2'] },
          },
        },
      ]),
    ).toBe(
      [
        'Slack block text:',
        'Chart: Weekly sales',
        'Category | Online',
        'Week 1 | 12',
        'Week 2 | 18',
      ].join('\n'),
    );
  });

  it('formats Slack forwarded message attachments for agent context', () => {
    const context = formatSlackForwardedMessageContext([
      {
        ts: '1776819983.463289',
        author_id: 'U0EXAMPLE01',
        channel_id: 'C0EXAMPLE01',
        is_msg_unfurl: true,
        is_share: true,
        from_url:
          'https://example.slack.com/archives/C0EXAMPLE01/p1776819983463289',
        text: 'excited about the roadmap update.',
        author_name: 'Annie Easley',
        footer: 'Slack Conversation',
      },
    ]);

    expect(context).toBe(
      [
        'Forwarded Slack message:',
        'Context:',
        '- Author: Annie Easley',
        '- Channel: C0EXAMPLE01',
        '- Source: https://example.slack.com/archives/C0EXAMPLE01/p1776819983463289',
        'Text:',
        'excited about the roadmap update.',
      ].join('\n'),
    );
  });

  it('appends forwarded context to the Slack message text', () => {
    expect(
      appendSlackForwardedMessageContext('can you see this?', [
        {
          is_share: true,
          text: 'Forwarded body',
          author_name: 'Alice',
        },
      ]),
    ).toBe(
      [
        'can you see this?',
        '',
        'Forwarded Slack message:',
        'Context:',
        '- Author: Alice',
        'Text:',
        'Forwarded body',
      ].join('\n'),
    );
  });

  it('formats Slack attachment title links for agent context', () => {
    const context = formatSlackAttachmentTitleContexts([
      {
        title: 'Production deploy failed',
        title_link: 'https://example.com/deploys/123',
        text: 'Click through for the failing job.',
        service_name: 'DeployBot',
      },
    ]);

    expect(context).toBe(
      [
        'Slack attachment:',
        'Author: DeployBot',
        'Title: Production deploy failed',
        'URL: https://example.com/deploys/123',
        'Text:',
        'Click through for the failing job.',
      ].join('\n'),
    );
  });

  it('appends attachment title links after forwarded context', () => {
    expect(
      appendSlackAttachmentContext('can you investigate?', [
        {
          is_share: true,
          text: 'Forwarded body',
          author_name: 'Alice',
        },
        {
          title: 'Incident 123',
          title_link: 'https://example.com/incidents/123',
        },
      ]),
    ).toBe(
      [
        'can you investigate?',
        '',
        'Forwarded Slack message:',
        'Context:',
        '- Author: Alice',
        'Text:',
        'Forwarded body',
        '',
        'Slack attachment:',
        'Title: Incident 123',
        'URL: https://example.com/incidents/123',
      ].join('\n'),
    );
  });

  it('formats Slack block link elements for agent context', () => {
    const context = formatSlackBlockLinkContext([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Open ' },
              {
                type: 'link',
                url: 'https://example.com/issues/123',
                text: 'Issue 123',
              },
            ],
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '<https://example.com/deploys/456|Deploy 456>',
        },
      },
    ]);

    expect(context).toBe(
      [
        'Slack block links:',
        '- Issue 123: https://example.com/issues/123',
        '- Deploy 456: https://example.com/deploys/456',
      ].join('\n'),
    );
  });

  it('decodes Slack entities in block links', () => {
    const context = formatSlackBlockLinkContext([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '<https://example.sentry.io/issues/7454501897/?referrer=slack&amp;environment=production|*e*>',
        },
      },
    ]);

    expect(context).toBe(
      [
        'Slack block links:',
        '- e: https://example.sentry.io/issues/7454501897/?referrer=slack&environment=production',
      ].join('\n'),
    );
  });

  it('extracts Sentry-style block and attachment context without action labels', () => {
    const context = appendSlackAttachmentContext(
      'investigate this sentry error',
      [
        {
          title: 'ROOMOTE-WEB-1A2 The CAPTCHA failed to load',
          title_link:
            'https://example.sentry.io/issues/7454501897/?referrer=slack',
          text: 'This may be due to an unsupported browser or a browser extension.',
          service_name: 'Sentry',
        },
      ],
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':red_circle: <https://example.sentry.io/issues/7454501897/?referrer=slack|*The CAPTCHA failed to load. This may be due to an unsupported browser.*>',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'State: *New* | First Seen: *2 hours ago* | Event Count: *42*',
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Resolve' },
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Ignore' },
            },
          ],
        },
      ],
    );

    expect(context).toContain(
      'https://example.sentry.io/issues/7454501897/?referrer=slack',
    );
    expect(context).not.toContain('Resolve');
    expect(context).not.toContain('Ignore');
  });

  it('formats useful Slack block text while skipping action controls', () => {
    const context = formatSlackBlockTextContext(
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':red_circle: <https://example.com/issues/123|*Issue title*>',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'State: *New*   First Seen: *Just now*',
            },
          ],
        },
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'Assigned to ' },
                { type: 'user', user_id: 'U123' },
              ],
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Resolve' },
            },
          ],
        },
      ],
      ':red_circle: Issue title',
    );

    expect(context).toBe(
      [
        'Slack block text:',
        'State: *New*   First Seen: *Just now*',
        'Assigned to <@U123>',
      ].join('\n'),
    );
  });

  it('formats an untitled workflow attachment body as agent context', () => {
    const context = formatSlackAttachmentContext(
      '*Suite — tests need updates*',
      [
        {
          id: 1,
          color: '2eb886',
          fallback: '[no preview available]',
          text: '<@U_BOT> $run-suite acme/api#42\n\nYour task: update the failing tests.',
        },
      ],
      [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                {
                  type: 'text',
                  text: 'Suite — tests need updates',
                  style: { bold: true },
                },
              ],
            },
          ],
        },
      ],
    );

    expect(context).toBe(
      [
        'Slack attachment:',
        'Text:',
        '<@U_BOT> $run-suite acme/api#42',
        '',
        'Your task: update the failing tests.',
      ].join('\n'),
    );
  });

  it('extracts app-unfurl attachment blocks without action controls', () => {
    const context = formatSlackAttachmentContext('Look at this', [
      {
        id: 1,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '<https://example.com/pull/42|*Pull request #42*>: fix the tests',
            },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: 'Open · 3 files changed' }],
          },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: 'Approve' } },
            ],
          },
        ],
      },
    ]);

    expect(context).toBe(
      [
        'Slack attachment:',
        'Text:',
        '*Pull request #42*: fix the tests',
        'Open · 3 files changed',
        '',
        'Slack block links:',
        '- Pull request #42: https://example.com/pull/42',
      ].join('\n'),
    );
  });

  it('formats container and table blocks with section fields', () => {
    const context = formatSlackBlockTextContext(
      [
        { type: 'header', text: { type: 'plain_text', text: 'Analysis' } },
        { type: 'divider' },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '*Status:* failing' },
            { type: 'mrkdwn', text: '*Runs:* 3' },
          ],
        },
        {
          type: 'container',
          title: { type: 'plain_text', text: 'Failed: checkout flow' },
          subtitle: { type: 'plain_text', text: '2 assertions' },
          child_blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: 'Expected the cart total to update.',
              },
            },
            {
              type: 'table',
              rows: [
                [
                  { type: 'raw_text', text: 'Step' },
                  { type: 'raw_text', text: 'Result' },
                ],
                [
                  { type: 'raw_text', text: 'Add item' },
                  { type: 'raw_text', text: 'ok' },
                ],
                [
                  { type: 'raw_text', text: 'Read total' },
                  { type: 'raw_text', text: 'timeout' },
                ],
              ],
            },
          ],
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Ran 2 minutes ago' }],
        },
      ],
      'Analysis',
    );

    expect(context).toBe(
      [
        'Slack block text:',
        '*Status:* failing',
        '*Runs:* 3',
        'Failed: checkout flow — 2 assertions',
        'Expected the cart total to update.',
        'Step | Result',
        'Add item | ok',
        'Read total | timeout',
        'Ran 2 minutes ago',
      ].join('\n'),
    );
  });

  it('keeps links from table cells and section fields', () => {
    const context = formatSlackAttachmentContext('Report', undefined, [
      {
        type: 'section',
        fields: [{ type: 'mrkdwn', text: '<https://example.com/run/9|Run 9>' }],
      },
      {
        type: 'container',
        child_blocks: [
          {
            type: 'table',
            rows: [
              [
                { type: 'raw_text', text: 'Test' },
                {
                  type: 'rich_text',
                  elements: [
                    {
                      type: 'rich_text_section',
                      elements: [
                        {
                          type: 'link',
                          url: 'https://example.com/tests/checkout',
                          text: 'checkout flow',
                        },
                      ],
                    },
                  ],
                },
              ],
            ],
          },
        ],
      },
    ]);

    expect(context).toBe(
      [
        'Slack block text:',
        'Run 9',
        'Test | checkout flow',
        '',
        'Slack block links:',
        '- Run 9: https://example.com/run/9',
        '- checkout flow: https://example.com/tests/checkout',
      ].join('\n'),
    );
  });

  it('preserves newlines between rich_text block sections', () => {
    const context = formatSlackBlockTextContext([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Assigned to ' },
              { type: 'user', user_id: 'U123' },
            ],
          },
          {
            type: 'rich_text_section',
            elements: [{ type: 'text', text: 'Priority high' }],
          },
        ],
      },
    ]);

    expect(context).toBe(
      ['Slack block text:', 'Assigned to <@U123>', 'Priority high'].join('\n'),
    );
  });

  it('formats attachment context independently from authored text', () => {
    const context = formatSlackAttachmentContext('Review:', undefined, [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Review: <https://new.example/2>',
        },
      },
    ]);

    expect(context).toBe(
      ['Slack block text:', 'Review: https://new.example/2'].join('\n'),
    );
  });

  it('appends Slack block link context to message text', () => {
    expect(
      appendSlackAttachmentContext('can you investigate?', undefined, [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'State: *New*' },
        },
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                {
                  type: 'link',
                  url: 'https://example.com/sentry/issue',
                  text: 'Sentry issue title',
                },
              ],
            },
          ],
        },
      ]),
    ).toBe(
      [
        'can you investigate?',
        '',
        'Slack block text:',
        'State: *New*',
        'Sentry issue title',
        '',
        'Slack block links:',
        '- Sentry issue title: https://example.com/sentry/issue',
      ].join('\n'),
    );
  });

  it('falls back to message_blocks when the attachment has no text', () => {
    const context = formatSlackForwardedMessageContext([
      {
        is_msg_unfurl: true,
        message_blocks: [
          {
            message: {
              blocks: [
                {
                  type: 'rich_text',
                  elements: [
                    {
                      type: 'rich_text_section',
                      elements: [
                        { type: 'text', text: 'hello ' },
                        { type: 'user', user_id: 'U123' },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(context).toContain('hello <@U123>');
  });

  it('extracts forwarded image files from nested forwarded messages', () => {
    const imageFile: SlackFile = {
      id: 'F-forwarded',
      name: 'forwarded.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/F-forwarded',
      url_private_download: 'https://files.slack.com/F-forwarded/download',
      size: 1_024,
    };

    expect(
      extractSlackForwardedMessageFiles([
        {
          is_share: true,
          message_blocks: [
            {
              message: {
                files: [imageFile],
              },
            },
          ],
        },
      ]),
    ).toEqual([imageFile]);
  });

  it('extracts forwarded image URLs from Slack share attachments', () => {
    expect(
      extractSlackForwardedMessageFiles([
        {
          is_share: true,
          image_url: 'https://files.slack.com/forwarded-image.png',
          image_bytes: 2_048,
          title: 'shared screenshot',
        },
      ]),
    ).toEqual([
      {
        id: expect.stringMatching(/^forwarded-/),
        name: 'shared screenshot',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/forwarded-image.png',
        url_private_download: 'https://files.slack.com/forwarded-image.png',
        size: 2_048,
      },
    ]);
  });

  it('prefers nested forwarded image files over share preview URLs', () => {
    const imageFile: SlackFile = {
      id: 'F-forwarded',
      name: 'forwarded.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/F-forwarded',
      url_private_download: 'https://files.slack.com/F-forwarded/download',
      size: 1_024,
    };

    expect(
      extractSlackForwardedMessageFiles([
        {
          is_share: true,
          image_url: 'https://files.slack.com/F-forwarded/preview.png',
          message_blocks: [
            {
              message: {
                files: [imageFile],
              },
            },
          ],
        },
      ]),
    ).toEqual([imageFile]);
  });

  it('keeps separate preview-only forwarded images alongside nested files', () => {
    const imageFile: SlackFile = {
      id: 'F-forwarded',
      name: 'forwarded.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/F-forwarded',
      url_private_download: 'https://files.slack.com/F-forwarded/download',
      size: 1_024,
    };

    expect(
      extractSlackForwardedMessageFiles([
        {
          is_share: true,
          image_url: 'https://files.slack.com/F-forwarded/preview.png',
          message_blocks: [
            {
              message: {
                files: [imageFile],
              },
            },
            {
              message: {
                image_url: 'https://files.slack.com/second-image.png',
                image_bytes: 2_048,
                title: 'second screenshot',
              },
            },
          ],
        },
      ]),
    ).toEqual([
      imageFile,
      {
        id: expect.stringMatching(/^forwarded-/),
        name: 'second screenshot',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/second-image.png',
        url_private_download: 'https://files.slack.com/second-image.png',
        size: 2_048,
      },
    ]);
  });

  it('keeps a distinct root preview image alongside nested forwarded files', () => {
    const imageFile: SlackFile = {
      id: 'F-forwarded',
      name: 'forwarded.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/F-forwarded',
      url_private_download: 'https://files.slack.com/F-forwarded/download',
      size: 1_024,
    };

    expect(
      extractSlackForwardedMessageFiles([
        {
          is_share: true,
          image_url: 'https://files.slack.com/root-distinct.png',
          image_bytes: 2_048,
          title: 'root screenshot',
          message_blocks: [
            {
              message: {
                files: [imageFile],
              },
            },
          ],
        },
      ]),
    ).toEqual([
      imageFile,
      {
        id: expect.stringMatching(/^forwarded-/),
        name: 'root screenshot',
        mimetype: 'image/png',
        filetype: 'png',
        url_private: 'https://files.slack.com/root-distinct.png',
        url_private_download: 'https://files.slack.com/root-distinct.png',
        size: 2_048,
      },
    ]);
  });

  it('merges forwarded image files with direct Slack files', () => {
    const directFile: SlackFile = {
      id: 'F-direct',
      name: 'direct.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/F-direct',
      url_private_download: 'https://files.slack.com/F-direct/download',
      size: 1_024,
    };
    const forwardedFile: SlackFile = {
      id: 'F-forwarded',
      name: 'forwarded.png',
      mimetype: 'image/png',
      filetype: 'png',
      url_private: 'https://files.slack.com/F-forwarded',
      url_private_download: 'https://files.slack.com/F-forwarded/download',
      size: 1_024,
    };

    expect(
      appendSlackForwardedMessageFiles(
        [directFile],
        [
          {
            is_msg_unfurl: true,
            files: [forwardedFile],
          },
        ],
      ),
    ).toEqual([directFile, forwardedFile]);
  });

  it('ignores unrelated Slack attachments', () => {
    expect(
      appendSlackForwardedMessageContext('plain message', [
        {
          title: 'Generic link unfurl',
          text: 'Do not add this to the prompt.',
        },
      ]),
    ).toBe('plain message');
    expect(
      extractSlackForwardedMessageFiles([
        {
          image_url: 'https://files.slack.com/unrelated.png',
        },
      ]),
    ).toEqual([]);
    expect(
      appendSlackAttachmentContext('plain message', [
        {
          fallback: 'Body only, no title.',
        },
      ]),
    ).toBe('plain message\n\nSlack attachment:\nText:\nBody only, no title.');
  });
});
