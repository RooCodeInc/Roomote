import { describe, expect, it } from 'vitest';

import { BRAIN_PAGE_TYPES, renderBrainFrontmatter } from '../brain';

describe('renderBrainFrontmatter', () => {
  it('leads with the fields gbrain lint requires, then the writer fields', () => {
    expect(
      renderBrainFrontmatter({
        type: BRAIN_PAGE_TYPES.slackDay,
        title: '#general — 2026-08-13',
        created: '2026-08-13',
        fields: ['date: 2026-08-13'],
      }),
    ).toEqual([
      '---',
      'type: slack',
      'title: "#general — 2026-08-13"',
      'created: 2026-08-13',
      'date: 2026-08-13',
      '---',
    ]);
  });

  it('quotes titles so YAML survives colons, hashes, and quotes', () => {
    const [, , title] = renderBrainFrontmatter({
      type: BRAIN_PAGE_TYPES.pullRequest,
      title: 'acme/widgets#42: fix "quoted" thing: really',
    });

    expect(title).toBe(
      'title: "acme/widgets#42: fix \\"quoted\\" thing: really"',
    );
  });

  it('renders Date instances as ISO timestamps and omits a missing created', () => {
    expect(
      renderBrainFrontmatter({
        type: BRAIN_PAGE_TYPES.person,
        title: 'Ada',
        created: new Date('2026-08-20T12:34:56.000Z'),
      }),
    ).toContain('created: 2026-08-20T12:34:56.000Z');
    expect(
      renderBrainFrontmatter({ type: BRAIN_PAGE_TYPES.person, title: 'Ada' }),
    ).toEqual(['---', 'type: person', 'title: "Ada"', '---']);
  });

  it('drops falsy optional fields so writers can inline conditionals', () => {
    expect(
      renderBrainFrontmatter({
        type: BRAIN_PAGE_TYPES.meeting,
        title: 'Standup',
        created: '2026-08-13',
        fields: [
          undefined,
          false,
          null,
          'provenance: roomote-granola-meetings',
        ],
      }),
    ).toEqual([
      '---',
      'type: meeting',
      'title: "Standup"',
      'created: 2026-08-13',
      'provenance: roomote-granola-meetings',
      '---',
    ]);
  });
});
