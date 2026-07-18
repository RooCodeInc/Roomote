import { describe, expect, it } from 'vitest';

import { buildCommunicationTaskThreadName } from '../communication-task-thread.js';

describe('buildCommunicationTaskThreadName', () => {
  it('keeps a short plain request as-is', () => {
    expect(buildCommunicationTaskThreadName('Fix the flaky tests')).toBe(
      'Fix the flaky tests',
    );
  });

  it('drops attachment summary noise from provisional titles', () => {
    expect(
      buildCommunicationTaskThreadName(
        'please fix this for @Sky Relifer\n\nImage: image.png',
      ),
    ).toBe('please fix this for @Sky Relifer');
  });

  it('strips leftover Discord mention markup that never resolved', () => {
    expect(
      buildCommunicationTaskThreadName(
        'please fix this for <@589419970627239947> Image: image.png',
      ),
    ).toBe('please fix this for');
  });

  it('falls back when only attachment noise remains', () => {
    expect(buildCommunicationTaskThreadName('Image: screenshot.png')).toBe(
      'Roomote task',
    );
  });

  it('truncates long titles with an ellipsis', () => {
    const long = 'a'.repeat(120);
    const name = buildCommunicationTaskThreadName(long, 20);
    expect(name).toHaveLength(20);
    expect(name.endsWith('…')).toBe(true);
  });
});
