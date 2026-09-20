import { describe, expect, it } from 'vitest';

import {
  buildMarkdownReplyQuote,
  createPendingFastAgentReplyQuote,
} from './fast-agent-reply-quote';

describe('Fast reply quotes', () => {
  it('escapes provider-rendered Markdown and truncates normalized text', () => {
    expect(
      buildMarkdownReplyQuote({
        senderDisplayName: 'Dana *Admin*',
        text: `Review [this] > ${'a'.repeat(300)}`,
      }),
    ).toBe(
      `> **Dana \\*Admin\\*:** Review \\[this\\] \\> ${'a'.repeat(264)}...`,
    );
  });

  it('keeps one provider-neutral quote pending until delivery succeeds', () => {
    const pending = createPendingFastAgentReplyQuote({
      senderDisplayName: 'Dana',
      text: 'Check this',
    });

    expect(pending.peek(buildMarkdownReplyQuote)).toBe(
      '> **Dana:** Check this',
    );
    expect(pending.peek(buildMarkdownReplyQuote)).toBe(
      '> **Dana:** Check this',
    );
    pending.markDelivered();
    expect(pending.peek(buildMarkdownReplyQuote)).toBeNull();
  });
});
