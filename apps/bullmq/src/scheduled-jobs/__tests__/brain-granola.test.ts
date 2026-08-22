import { describe, expect, it, vi } from 'vitest';

import {
  buildGranolaMeetingPage,
  fetchGranolaNoteDetail,
} from '../brain-collectors/granola-meetings';

describe('buildGranolaMeetingPage', () => {
  const fixture = {
    id: 'not_abc123def45678',
    title: 'Weekly Growth Sync',
    created_at: '2026-08-10T15:00:00Z',
    updated_at: '2026-08-10T16:30:00Z',
    attendees: [{ name: 'Matt' }, 'danny@example.com', { email: 'x@y.z' }],
    summary: 'Discussed the ops wedge. '.repeat(200),
  };

  it('maps a meeting note to a dated page', () => {
    const result = buildGranolaMeetingPage(fixture);

    expect(result).not.toBeNull();
    expect(result?.page.slug).toBe(
      'meetings/2026-08-10-weekly-growth-sync-not-abc123def45678',
    );
    expect(result?.page.title).toBe('Weekly Growth Sync');
    expect(result?.updatedAt).toEqual(new Date('2026-08-10T16:30:00Z'));
    expect(result?.page.content).toContain('# Weekly Growth Sync');
    expect(result?.page.content).toContain('- Matt');
    expect(result?.page.content).toContain('- danny@example.com');
    expect(result?.page.content).toContain('- x@y.z');
    expect(result?.page.content).toContain(
      'granola_note_id: not_abc123def45678',
    );
  });

  it('uses Granola detail response summary fields', () => {
    const result = buildGranolaMeetingPage({
      ...fixture,
      summary: undefined,
      summary_markdown: '## Decisions\n\nShip the detail collector.',
      summary_text: 'Plain-text fallback.',
    });

    expect(result?.page.content).toContain(
      '## Decisions\n\nShip the detail collector.',
    );
    expect(result?.page.content).not.toContain('Plain-text fallback.');
  });

  it('falls back to Granola plain-text summaries', () => {
    const result = buildGranolaMeetingPage({
      ...fixture,
      summary: undefined,
      summary_text: 'Plain-text meeting summary.',
    });

    expect(result?.page.content).toContain('Plain-text meeting summary.');
  });

  it('caps the notes excerpt at 3000 characters', () => {
    const result = buildGranolaMeetingPage(fixture);
    const notesSection = result?.page.content.split('## Notes')[1] ?? '';

    expect(fixture.summary.length).toBeGreaterThan(3000);
    expect(notesSection.length).toBeLessThanOrEqual(3010);
  });

  it('falls back to the note id when the title is missing', () => {
    const result = buildGranolaMeetingPage({
      id: 'not_abc123def45678',
      created_at: '2026-08-10T15:00:00Z',
    });

    expect(result?.page.slug).toBe(
      'meetings/2026-08-10-untitled-meeting-not-abc123def45678',
    );
    expect(result?.page.title).toBe('Untitled meeting');
  });

  it('returns null for unusable input instead of throwing', () => {
    expect(buildGranolaMeetingPage(null)).toBeNull();
    expect(buildGranolaMeetingPage(42)).toBeNull();
    expect(buildGranolaMeetingPage('string')).toBeNull();
    expect(buildGranolaMeetingPage({})).toBeNull();
  });

  it('keeps same-day meetings with the same title distinct', () => {
    const first = buildGranolaMeetingPage({ ...fixture, id: 'note-1' });
    const second = buildGranolaMeetingPage({ ...fixture, id: 'note-2' });

    expect(first?.page.slug).not.toBe(second?.page.slug);
  });

  it('links known attendees to canonical person pages without exposing email', () => {
    const identities = new Map([
      [
        'danny@example.com',
        { slug: 'people/roomote-member-abc', title: 'Dan Riccio' },
      ],
    ]);
    const result = buildGranolaMeetingPage(fixture, identities);

    expect(result?.page.content).toContain(
      'attendees: ["people/roomote-member-abc"]',
    );
    expect(result?.page.content).toContain(
      '- [Dan Riccio](people/roomote-member-abc)',
    );
    expect(result?.page.content).not.toContain('- danny@example.com');
    expect(result?.page.timelineEvidence).toEqual([
      {
        slug: 'people/roomote-member-abc',
        date: '2026-08-10',
        summary: 'Attended a meeting recorded in Granola',
        source: 'granola:note:not_abc123def45678',
      },
    ]);
  });

  it('keeps timeline evidence stable when a meeting title or notes change', () => {
    const identities = new Map([
      [
        'danny@example.com',
        { slug: 'people/roomote-member-abc', title: 'Dan Riccio' },
      ],
    ]);
    const original = buildGranolaMeetingPage(fixture, identities);
    const edited = buildGranolaMeetingPage(
      {
        ...fixture,
        title: 'Renamed Growth Sync',
        summary: 'Completely revised meeting notes.',
      },
      identities,
    );

    expect(edited?.page.timelineEvidence).toEqual(
      original?.page.timelineEvidence,
    );
    expect(edited?.page.timelineEvidence?.[0]).not.toHaveProperty('detail');
  });

  it('does not emit an invalid timeline date for undated meeting input', () => {
    const result = buildGranolaMeetingPage(
      {
        id: 'note-without-date',
        title: 'Undated meeting',
        attendees: ['Matt'],
      },
      new Map([['matt', { slug: 'people/roomote-member-abc', title: 'Matt' }]]),
    );

    expect(result?.page.timelineEvidence).toEqual([]);
    // No honest date means no `created` at all, never a placeholder.
    expect(result?.page.content).not.toContain('\ncreated:');
    expect(result?.page.content).toContain('\ntype: meeting\n');
  });

  it('tries both attendee name and email before leaving a person unresolved', () => {
    const identities = new Map([
      [
        'dan@example.com',
        { slug: 'people/roomote-member-abc', title: 'Dan Riccio' },
      ],
    ]);
    const result = buildGranolaMeetingPage(
      {
        ...fixture,
        attendees: [{ name: 'Danny', email: 'dan@example.com' }],
      },
      identities,
    );

    expect(result?.page.content).toContain(
      '- [Dan Riccio](people/roomote-member-abc)',
    );
    expect(result?.page.content).not.toContain('dan@example.com');
  });

  it('fetches the full Granola note record before mapping it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({
        ...fixture,
        summary_markdown: '## Full meeting summary',
      }),
    );

    const detail = await fetchGranolaNoteDetail(fixture, 'granola-test-key');

    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('https://public-api.granola.ai/v1/notes/not_abc123def45678'),
      {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer granola-test-key',
        },
      },
    );
    expect(detail).toMatchObject({
      id: 'not_abc123def45678',
      summary_markdown: '## Full meeting summary',
    });

    fetchSpy.mockRestore();
  });
});
