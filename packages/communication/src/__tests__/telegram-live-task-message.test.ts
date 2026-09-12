import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TELEGRAM_MAX_RICH_MESSAGE_LENGTH } from '../telegram-format';
import { buildTelegramLiveTaskMessage } from '../telegram-live-task-message';

describe('buildTelegramLiveTaskMessage', () => {
  it('uses the current activity as the collapsed expandable quote line', () => {
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
        '<blockquote expandable>Fixing bug…\n\nUpdating the task lifecycle and rerunning focused tests.</blockquote>',
      footerText:
        'Open in Roomote: https://roomote.example/sessions/session-1?task=task-1&utm_source=telegram',
      footerHtmlText:
        '<a href="https://roomote.example/sessions/session-1?task=task-1&amp;utm_source=telegram">Open in Roomote</a>',
    });
  });

  it.each([
    ['waiting', 'Waiting for your input…'],
    ['completed', 'Completed.'],
    ['failed', 'Task failed.'],
    ['stopped', 'Stopped.'],
  ] as const)('formats %s as one compact line', (status, expected) => {
    expect(buildTelegramLiveTaskMessage({ status })).toMatchObject({
      text: expected,
      htmlText: expected,
    });
  });

  it('escapes expandable HTML without splitting entities or exceeding one message', () => {
    const message = buildTelegramLiveTaskMessage({
      status: 'running',
      progress: `Fixing <Telegram>...\n${'<>&'.repeat(TELEGRAM_MAX_RICH_MESSAGE_LENGTH)}`,
    });

    expect(message.htmlText).toContain('Fixing &lt;Telegram&gt;...');
    expect(message.htmlText).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(message.htmlText.endsWith('</blockquote>')).toBe(true);
    expect(message.text.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
    );
    expect(message.htmlText.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_RICH_MESSAGE_LENGTH,
    );
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
      'COMPLETED',
      joinMessage(
        buildTelegramLiveTaskMessage({ status: 'completed', taskUrl }),
      ),
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
