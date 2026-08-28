import { describe, expect, it } from 'vitest';

import {
  buildRipplingWorkerPage,
  buildRipplingWorkersRequest,
  buildUnavailableRipplingWorkerPage,
  parseRipplingSnapshotCursor,
  parseRipplingWorkersResponse,
} from '../brain-collectors/rippling-workers';

describe('Rippling worker pages', () => {
  const worker = {
    id: 'worker-ada',
    status: 'ACTIVE',
    work_email: 'ada@example.com',
    title: 'Principal Engineer',
    start_date: '2024-01-15',
    user: {
      name: { display_name: 'Ada Lovelace' },
      number: 'E-1001',
      timezone: 'America/Los_Angeles',
    },
    manager_id: 'worker-grace',
    manager: {
      id: 'worker-grace',
      work_email: 'grace@example.com',
      user: { name: { display_name: 'Grace Hopper' } },
    },
    department_id: 'department-engineering',
    department: { id: 'department-engineering', name: 'Engineering' },
    teams: [{ id: 'team-platform', name: 'Platform' }],
    employment_type: { type: 'EMPLOYEE', label: 'Full time' },
    location: { type: 'REMOTE' },
  };

  it('projects authoritative employment, reporting, membership, and freshness data', () => {
    const page = buildRipplingWorkerPage({
      worker,
      observedAt: new Date('2026-08-17T12:30:00Z'),
      snapshotStartedAt: new Date('2026-08-17T12:00:00Z'),
    });

    expect(page?.slug).toMatch(/^people\/rippling-worker-[a-f0-9]{16}$/);
    expect(page?.content).toContain('type: person');
    expect(page?.content).toContain('source_authority: authoritative-hris');
    expect(page?.content).toContain('work_email: "ada@example.com"');
    expect(page?.content).toContain('employee_number: "E-1001"');
    expect(page?.content).toContain('rippling_manager_id: "worker-grace"');
    expect(page?.content).toContain('job_title: "Principal Engineer"');
    expect(page?.content).toContain('employment_type: "Full time"');
    expect(page?.content).toContain('timezone: "America/Los_Angeles"');
    expect(page?.content).toContain('start_date: "2024-01-15"');
    expect(page?.content).toContain('reports_to: "people/rippling-worker-');
    expect(page?.content).toContain('"type":"department"');
    expect(page?.content).toContain('"type":"team"');
    expect(page?.content).toContain(
      'Reporting and membership fields above come directly from Rippling HRIS',
    );
  });

  it('links matching work emails to the canonical Roomote person', () => {
    const page = buildRipplingWorkerPage({
      worker,
      observedAt: new Date('2026-08-17T12:30:00Z'),
      snapshotStartedAt: new Date('2026-08-17T12:00:00Z'),
      identities: new Map([
        [
          'ada@example.com',
          { slug: 'people/roomote-member-ada', title: 'Ada Lovelace' },
        ],
        [
          'grace@example.com',
          { slug: 'people/roomote-member-grace', title: 'Grace Hopper' },
        ],
      ]),
    });

    expect(page?.content).toContain('type: person-alias');
    expect(page?.content).toContain('canonical: "people/roomote-member-ada"');
    expect(page?.content).toContain(
      'reports_to: "people/roomote-member-grace"',
    );
  });

  it('preserves Rippling termination state while removing active aliases', () => {
    const page = buildRipplingWorkerPage({
      worker: { ...worker, status: 'TERMINATED', end_date: '2026-08-01' },
      observedAt: new Date('2026-08-17T12:30:00Z'),
      snapshotStartedAt: new Date('2026-08-17T12:00:00Z'),
    });

    expect(page?.content).toContain('status: inactive');
    expect(page?.content).toContain('source_status: "TERMINATED"');
    expect(page?.content).toContain('end_date: "2026-08-01"');
    expect(page?.content).toContain('aliases: []');
  });

  it('preserves the opaque next page link for a resumable snapshot', () => {
    expect(
      parseRipplingWorkersResponse({
        results: [worker],
        next_link:
          'https://rest.ripplingapis.com/workers/?cursor=opaque-next-page',
      }),
    ).toEqual({
      workers: [worker],
      nextLink:
        'https://rest.ripplingapis.com/workers/?cursor=opaque-next-page',
    });
    expect(
      parseRipplingSnapshotCursor(
        JSON.stringify({
          mode: 'scan',
          startedAt: '2026-08-17T12:00:00.000Z',
          nextLink:
            'https://rest.ripplingapis.com/workers/?cursor=opaque-next-page',
        }),
      ),
    ).toMatchObject({ mode: 'scan', startedAt: '2026-08-17T12:00:00.000Z' });
  });

  it('reapplies relationship expansions to cursor-only continuation links', () => {
    expect(
      buildRipplingWorkersRequest(
        'https://rest.ripplingapis.com/workers/?cursor=opaque-next-page',
        100,
      ),
    ).toEqual({
      pathOrUrl:
        'https://rest.ripplingapis.com/workers/?cursor=opaque-next-page',
      query: {
        expand: 'user,manager,manager.user,department,employment_type,teams',
      },
    });
  });

  it('rejects malformed roster pages before reconciliation can advance', () => {
    expect(() =>
      parseRipplingWorkersResponse({ results: [{ status: 'ACTIVE' }] }),
    ).toThrow('invalid worker at index 0');
  });

  it('turns workers missing from a complete snapshot into unavailable tombstones', () => {
    const page = buildUnavailableRipplingWorkerPage({
      itemId: 'worker-former',
      slug: 'people/rippling-worker-former',
    });

    expect(page.slug).toBe('people/rippling-worker-former');
    expect(page.content).toContain('status: unavailable');
    expect(page.content).toContain('aliases: []');
    expect(page.content).toContain('rippling_worker_id: "worker-former"');
  });
});
