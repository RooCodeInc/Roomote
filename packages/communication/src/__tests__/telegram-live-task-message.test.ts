import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../telegram-format';
import { buildTelegramLiveTaskMessage } from '../telegram-live-task-message';

describe('buildTelegramLiveTaskMessage', () => {
  it('formats compact running state with expandable progress and task button', () => {
    expect(
      buildTelegramLiveTaskMessage({
        title: 'Implement Telegram live task updates',
        status: 'running',
        elapsedSeconds: 125,
        progress:
          'Running focused tests.\nThe payload and lifecycle suites are passing.',
        taskUrl: 'https://roomote.example/tasks/task-1',
      }),
    ).toEqual({
      text: [
        '⏳ Roomote task',
        'Running · 2m 5s',
        'Implement Telegram live task updates',
        '',
        'Current activity',
        'Running focused tests. The payload and lifecycle suites are passing.',
        '',
        'Progress',
        'Running focused tests.',
        'The payload and lifecycle suites are passing.',
      ].join('\n'),
      htmlText: [
        '<b>⏳ Roomote task</b>',
        'Running · 2m 5s',
        'Implement Telegram live task updates',
        '',
        '<b>Current activity</b>',
        'Running focused tests. The payload and lifecycle suites are passing.',
        '',
        '<blockquote expandable><b>Progress</b>',
        'Running focused tests.',
        'The payload and lifecycle suites are passing.</blockquote>',
      ].join('\n'),
      buttons: [
        [
          {
            text: 'Open in Roomote',
            url: 'https://roomote.example/tasks/task-1',
          },
        ],
      ],
    });
  });

  it.each([
    ['waiting', '⏸️', 'Waiting for input'],
    ['completed', '✅', 'Completed'],
    ['failed', '⚠️', 'Failed'],
    ['stopped', '⏹️', 'Stopped'],
  ] as const)('formats %s as a compact status edit', (status, icon, label) => {
    const message = buildTelegramLiveTaskMessage({
      title: 'Implement the feature',
      status,
      elapsedSeconds: 60,
      progress: undefined,
    });

    expect(message.text).toBe(
      `${icon} Roomote task\n${label} · 1m\nImplement the feature`,
    );
    expect(message.htmlText).toBe(
      `<b>${icon} Roomote task</b>\n${label} · 1m\nImplement the feature`,
    );
    expect(message.text).not.toContain('Result');
  });

  it('escapes expandable HTML and keeps both payloads within one message', () => {
    const message = buildTelegramLiveTaskMessage({
      title: 'Implement <Telegram>',
      status: 'running',
      progress: '<>&'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH),
    });

    expect(message.htmlText).toContain('&lt;&gt;&amp;');
    expect(message.htmlText).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(message.htmlText.endsWith('</blockquote>')).toBe(true);
    expect(message.text.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_MESSAGE_LENGTH,
    );
    expect(message.htmlText.length).toBeLessThanOrEqual(
      TELEGRAM_MAX_MESSAGE_LENGTH,
    );
  });

  it('matches the checked-in text demo fixture', () => {
    const title = 'Implement Telegram live task updates';
    const running = buildTelegramLiveTaskMessage({
      title,
      status: 'running',
      elapsedSeconds: 125,
      progress:
        'Running focused tests.\nThe payload and lifecycle suites are passing.',
    });
    const terminal = (
      status: 'completed' | 'failed' | 'stopped',
      elapsedSeconds: number,
    ) => buildTelegramLiveTaskMessage({ title, status, elapsedSeconds }).text;
    const fixture = [
      'RUNNING',
      running.text,
      '',
      'WAITING',
      buildTelegramLiveTaskMessage({
        title,
        status: 'waiting',
        elapsedSeconds: 150,
        progress: 'Waiting for your input…',
      }).text,
      '',
      'COMPLETED',
      terminal('completed', 180),
      '',
      'FAILED',
      terminal('failed', 45),
      '',
      'STOPPED',
      terminal('stopped', 30),
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
