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
        ':red_circle: *Issue title*',
        'State: *New*   First Seen: *Just now*',
        'Assigned to <@U123>',
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

  it('preserves differently formatted block text as agent context', () => {
    const context = formatSlackBlockTextContext(
      [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'Really bad experience here  ' },
                { type: 'text', text: " let's try to debug" },
              ],
            },
          ],
        },
      ],
      [
        "Really bad experience here <https://example.com/thread>  let's try to debug",
        '',
        'Forwarded Slack message:',
        'Text:',
        'Can you help?',
      ].join('\n'),
    );

    expect(context).toBe(
      [
        'Slack block text:',
        "Really bad experience here   let's try to debug",
      ].join('\n'),
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
          text: 'Do not add this to the prompt.',
        },
      ]),
    ).toBe('plain message');
  });
});
