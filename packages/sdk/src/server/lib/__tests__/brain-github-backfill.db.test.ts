import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import {
  brainSyncState,
  db,
  eq,
  getBrainSyncState,
  githubInstallationFactory,
  githubInstallations,
  repositories,
  repositoryFactory,
  upsertBrainSyncState,
  userFactory,
  users,
} from '@roomote/db/server';

vi.mock('@roomote/github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/github')>();
  return {
    ...actual,
    getInstallationOctokit: async () => actual.getOctokit('disposable-fixture'),
  };
});

import { backfillBrainGithubIssuesStep } from '../brain-github';

it('recovers a rejected legacy page and durably resumes opaque GitHub cursors after a provider failure', async () => {
  const id = randomUUID();
  const collectorId = `test-github-cursor-${id}`;
  const fullName = `fixture-${id}/widgets`;
  const user = await userFactory.create();
  const installation = await githubInstallationFactory.create({
    installedByUserId: user.id,
  });
  const repository = await repositoryFactory.create({
    fullName,
    linkedByUserId: user.id,
    installationId: installation.id,
  });
  const requests: URL[] = [];
  let failContinuation = true;
  let server: Server | undefined;
  const realFetch = globalThis.fetch;

  try {
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      requests.push(url);
      response.setHeader('content-type', 'application/json');
      if (url.searchParams.has('page')) {
        response.writeHead(422).end(
          JSON.stringify({
            message:
              'Pagination with the page parameter is not supported for large datasets, please use cursor based pagination (after/before)',
          }),
        );
        return;
      }
      const after = url.searchParams.get('after');
      if (after && failContinuation) {
        response
          .writeHead(503)
          .end(JSON.stringify({ message: 'temporary provider outage' }));
        return;
      }
      if (url.pathname.endsWith('/comments')) {
        response.end(
          JSON.stringify([
            {
              id: 1,
              body: 'Fixture discussion',
              user: { login: 'fixture' },
              created_at: '2026-08-01T00:00:00Z',
            },
          ]),
        );
        return;
      }
      if (!after) {
        // GitHub's actual next link carries both an opaque after and page.
        response.setHeader(
          'link',
          '<https://api.github.com/repositories/123/issues?after=opaque%2B1%3D&page=2>; rel="next"',
        );
      }
      response.end(
        JSON.stringify(
          Array.from({ length: 50 }, (_, index) => ({
            number: (after ? 51 : 1) + index,
            title: `Fixture issue ${(after ? 51 : 1) + index}`,
            body: 'Fixture body',
            comments: index === 0 ? 1 : 0,
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-02T00:00:00Z',
            ...(index === 49 ? { pull_request: {} } : {}),
          })),
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal(
      'fetch',
      (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        expect(url.origin).toBe('https://api.github.com');
        expect(url.pathname).toMatch(new RegExp(`^/repos/${fullName}/issues`));
        return realFetch(`${origin}${url.pathname}${url.search}`, init);
      },
    );

    const originalCursor = JSON.stringify({
      completed: ['fixture/already-read'],
      repository: fullName,
      page: 200,
    });
    await upsertBrainSyncState(db, collectorId, {
      backfillCursor: originalCursor,
    });
    const step = async () => {
      const before = await getBrainSyncState(db, collectorId);
      const result = await backfillBrainGithubIssuesStep({
        cursor: before?.backfillCursor ?? null,
      });
      await upsertBrainSyncState(db, collectorId, {
        backfillCursor: result.nextCursor,
      });
      return result;
    };
    const recovery = await step();
    expect(recovery.done).toBe(false);
    expect(recovery.pages).toEqual([]);
    expect(recovery.nextCursor).not.toBe(originalCursor);

    const first = await step();
    expect(first.pages).toHaveLength(49);
    expect(first.pages[0]?.content).toContain('Fixture discussion');
    const persisted = await getBrainSyncState(db, collectorId);
    expect(JSON.parse(persisted!.backfillCursor!)).toMatchObject({
      after: 'opaque+1=',
      completed: ['fixture/already-read'],
    });

    const failure = await step();
    expect(failure.pages).toEqual([]);
    expect((await getBrainSyncState(db, collectorId))?.backfillCursor).toBe(
      persisted?.backfillCursor,
    );
    failContinuation = false;
    const second = await step();
    expect(second.pages).toHaveLength(49);
    expect(second.pages[0]?.slug).toBe(`github/${fullName}/issues/51`);
    const completed = JSON.parse(
      (await getBrainSyncState(db, collectorId))!.backfillCursor!,
    );
    expect(completed.repository).toBeNull();
    expect(completed.completed).toContain(fullName);
    expect(requests.filter((url) => url.searchParams.has('page'))).toHaveLength(
      1,
    );
    expect(
      requests.filter((url) => url.searchParams.get('after') === 'opaque+1='),
    ).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
    server?.closeAllConnections();
    if (server?.listening)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db
      .delete(brainSyncState)
      .where(eq(brainSyncState.collectorId, collectorId));
    await db.delete(repositories).where(eq(repositories.id, repository.id));
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, installation.id));
    await db.delete(users).where(eq(users.id, user.id));
  }
}, 30_000);
