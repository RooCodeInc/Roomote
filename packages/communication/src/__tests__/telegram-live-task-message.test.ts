import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../telegram-format';
import { buildTelegramLiveTaskMessage } from '../telegram-live-task-message';

describe('buildTelegramLiveTaskMessage', () => {
  it('uses the current activity as the collapsed expandable quote line', () => {
    expect(
      buildTelegramLiveTaskMessage({
        status: 'running',
        progress:
          'Fixing bug…\nUpdating the task lifecycle and rerunning focused tests.',
        taskUrl: 'https://roomote.example/tasks/task-1',
      }),
    ).toEqual({
      text: 'Fixing bug…\n\nUpdating the task lifecycle and rerunning focused tests.',
      htmlText:
        '<blockquote expandable>Fixing bug…\n\nUpdating the task lifecycle and rerunning focused tests.</blockquote>',
      buttons: [
        [
          {
            text: 'Open task',
            url: 'https://roomote.example/tasks/task-1',
          },
        ],
      ],
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
      progress: `Fixing <Telegram>...\n${'<>&'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH)}`,
    });

    expect(message.htmlText).toContain('Fixing &lt;Telegram&gt;...');
    expect(message.htmlText).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(message.htmlText.endsWith('</blockquote>')).toBe(true);
    expect(message.text.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_MESSAGE_LENGTH,
    );
    expect(message.htmlText.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_MESSAGE_LENGTH,
    );
  });

  it('matches the checked-in compact text demo fixture', () => {
    const running = buildTelegramLiveTaskMessage({
      status: 'running',
      progress:
        'Fixing bug…\nUpdating the task lifecycle and rerunning focused tests.',
    });
    const fixture = [
      'RUNNING',
      running.text,
      '',
      'WAITING',
      buildTelegramLiveTaskMessage({ status: 'waiting' }).text,
      '',
      'COMPLETED',
      buildTelegramLiveTaskMessage({ status: 'completed' }).text,
      '',
      'FAILED',
      buildTelegramLiveTaskMessage({ status: 'failed' }).text,
      '',
      'STOPPED',
      buildTelegramLiveTaskMessage({ status: 'stopped' }).text,
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
