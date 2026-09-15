import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
  planTelegramRichMessages,
} from '../telegram-format';
import { buildTelegramLiveTaskMessage } from '../telegram-live-task-message';

describe('buildTelegramLiveTaskMessage', () => {
  it('uses the current activity as the collapsed details summary', () => {
    expect(
      buildTelegramLiveTaskMessage({
        status: 'running',
        progress:
          'Fixing bug…\nUpdating the task lifecycle and rerunning focused tests.',
        taskUrl:
          'https://roomote.example/sessions/session-1?task=task-1&utm_source=telegram',
      }),
    ).toEqual({
      text: [
        'Fixing bug…',
        '',
        'Updating the task lifecycle and rerunning focused tests.',
      ].join('\n'),
      htmlText:
        '<details><summary>Fixing bug…</summary>\n\nUpdating the task lifecycle and rerunning focused tests.\n\n</details>',
      footerText:
        'Open in Roomote: https://roomote.example/sessions/session-1?task=task-1&utm_source=telegram',
      footerHtmlText:
        '<a href="https://roomote.example/sessions/session-1?task=task-1&amp;utm_source=telegram">Open in Roomote</a>',
    });
  });

  it('keeps Markdown block boundaries inside details and hides internal attachment paths', () => {
    const message = buildTelegramLiveTaskMessage({
      status: 'running',
      progress: [
        'Based on visual inspection of `/tmp/roomote-opencode-visual-attachments/session/message/image-1.jpg`, here are the facts:',
        '',
        '### Visible formatting',
        '',
        '- Literal example: `**not bold**`',
      ].join('\n'),
    });

    expect(message.text).not.toContain('roomote-opencode-visual-attachments');
    expect(message.htmlText).toBe(
      [
        '<details><summary>Based on visual inspection of the attached image, here are the facts:</summary>',
        '',
        '### Visible formatting',
        '',
        '- Literal example: `**not bold**`',
        '',
        '</details>',
      ].join('\n'),
    );
  });

  it('keeps single-line running progress visibly plain', () => {
    expect(
      buildTelegramLiveTaskMessage({
        status: 'running',
        progress: 'Running focused tests.',
      }),
    ).toMatchObject({
      text: 'Running focused tests.',
      htmlText: 'Running focused tests.',
    });
  });

  it.each([
    ['waiting', 'Waiting for your input…'],
    ['failed', 'Task failed.'],
    ['stopped', 'Stopped.'],
  ] as const)('formats %s as one compact line', (status, expected) => {
    expect(buildTelegramLiveTaskMessage({ status })).toMatchObject({
      text: expected,
      htmlText: expected,
    });
  });

  it('escapes details HTML without splitting entities or exceeding one message', () => {
    const message = buildTelegramLiveTaskMessage({
      status: 'running',
      progress: `Fixing <Telegram>...\n${'<>&'.repeat(TELEGRAM_MAX_RICH_MESSAGE_LENGTH)}`,
    });

    expect(message.htmlText).toContain('Fixing &lt;Telegram&gt;...');
    expect(message.htmlText).toContain(
      '</summary>\n\n&lt;&gt;&amp;&lt;&gt;&amp;',
    );
    expect(message.htmlText).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(message.htmlText.endsWith('</details>')).toBe(true);
    expect(message.text.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
    );
    expect(message.htmlText.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
    );
  });

  it('reserves the native footer envelope in near-limit embedded HTML', () => {
    const message = buildTelegramLiveTaskMessage({
      status: 'running',
      progress: `Working\n${'x'.repeat(TELEGRAM_MAX_RICH_MESSAGE_LENGTH)}`,
      taskUrl: 'https://roomote.test/sessions/1?task=2',
    });
    const chunks = planTelegramRichMessages({
      ...message,
      textFormat: 'plain',
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.richMessage.markdown.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
    );
    expect(chunks[0]!.richMessage.markdown.startsWith('<details>')).toBe(true);
    expect(chunks[0]!.richMessage.markdown).toContain('<footer>');
  });

  it('matches the checked-in compact text demo fixture', () => {
    const taskUrl =
      'https://roomote.example/sessions/session-1?task=task-1&utm_source=telegram';
    const running = buildTelegramLiveTaskMessage({
      status: 'running',
      progress:
        'Fixing bug…\nUpdating the task lifecycle and rerunning focused tests.',
      taskUrl,
    });
    const fixture = [
      'RUNNING',
      [running.text, running.footerText].filter(Boolean).join('\n\n'),
      '',
      'WAITING',
      joinMessage(buildTelegramLiveTaskMessage({ status: 'waiting', taskUrl })),
      '',
      'FAILED',
      joinMessage(buildTelegramLiveTaskMessage({ status: 'failed', taskUrl })),
      '',
      'STOPPED',
      joinMessage(buildTelegramLiveTaskMessage({ status: 'stopped', taskUrl })),
      '',
    ].join('\n');

    expect(fixture).toBe(
      readFileSync(
        new URL('./fixtures/telegram-live-task-message.txt', import.meta.url),
        'utf8',
      ),
    );
  });
});

function joinMessage(message: { text: string; footerText?: string }): string {
  return [message.text, message.footerText].filter(Boolean).join('\n\n');
}
