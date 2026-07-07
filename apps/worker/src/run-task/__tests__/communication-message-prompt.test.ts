// pnpm --filter @roomote/worker test src/run-task/__tests__/communication-message-prompt.test.ts
import { describe, expect, it } from 'vitest';

import { wrapCommunicationMessage } from '../communication-message-prompt';

describe('wrapCommunicationMessage', () => {
  it('wraps provider messages with author, channel, and thread attributes', () => {
    expect(
      wrapCommunicationMessage('teams', {
        ts: 'activity-1',
        user: 'Matt Rubens',
        channel: '19:conversation@thread.v2',
        threadTs: 'activity-root',
        text: 'Please also update the docs',
      }),
    ).toBe(
      '<communication_message provider="teams" ts="activity-1" author="Matt Rubens" channel="19:conversation@thread.v2" thread="activity-root">\nPlease also update the docs\n</communication_message>',
    );
  });

  it('omits missing optional attributes', () => {
    expect(
      wrapCommunicationMessage('telegram', {
        ts: 'update-1',
        user: '',
        text: 'hello',
      }),
    ).toBe(
      '<communication_message provider="telegram" ts="update-1">\nhello\n</communication_message>',
    );
  });

  it('escapes markup in attributes and content', () => {
    expect(
      wrapCommunicationMessage('teams', {
        ts: 'activity-2',
        user: '<at>Bot</at> "Friend"',
        text: 'watch out for <tags> & "quotes"',
      }),
    ).toBe(
      '<communication_message provider="teams" ts="activity-2" author="&lt;at&gt;Bot&lt;/at&gt; &quot;Friend&quot;">\nwatch out for &lt;tags&gt; &amp; "quotes"\n</communication_message>',
    );
  });
});
