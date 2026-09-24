import { describe, expect, it } from 'vitest';

import { appendOriginalRequestToTaskText } from '../fast-agent-original-request';

describe('appendOriginalRequestToTaskText', () => {
  it('appends the requester messages verbatim after the brief', () => {
    const request =
      'Open a dialog like the Apply one.\n• Put *Delete* in its footer, not the dropdown.';

    expect(
      appendOriginalRequestToTaskText({
        text: '  Add custom presets.  ',
        requests: [request, 'Also keep the Escape behavior.'],
      }),
    ).toBe(
      [
        'Add custom presets.',
        [
          '<original_request>',
          "The requester's own words from the conversation that produced this brief, forwarded verbatim. The brief above sets this task's scope. Within that scope, follow these words for exact requirements, wording, layout, and component choices the brief may have condensed; where they conflict with the brief, the requester's words win.",
          '<message>',
          request,
          '</message>',
          '<message>',
          'Also keep the Escape behavior.',
          '</message>',
          '</original_request>',
        ].join('\n'),
      ].join('\n\n'),
    );
  });

  it('returns the brief unchanged when there is no request to forward', () => {
    expect(
      appendOriginalRequestToTaskText({
        text: 'Fix checkout.',
        requests: ['', '   '],
      }),
    ).toBe('Fix checkout.');
  });

  it('skips requests the brief already quotes and repeated requests', () => {
    const result = appendOriginalRequestToTaskText({
      text: 'The user asked:\nFix   the checkout\nretry.',
      requests: ['Fix the checkout retry.', 'Add a test.', ' Add a test. '],
    });

    expect(result).not.toContain('<message>\nFix the checkout retry.');
    expect(result.match(/<message>/g)).toHaveLength(1);
    expect(result).toContain('<message>\nAdd a test.\n</message>');
  });
});
